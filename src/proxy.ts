/**
 * MimicScribe Gemini API Proxy
 *
 * This Cloudflare Worker sits between the MimicScribe desktop app and Google's
 * Gemini API. Its job is to:
 *
 *   1. Authenticate requests (trial device IDs or license keys)
 *   2. Strip all identity headers before forwarding to Google
 *   3. Forward the request body to Gemini without reading or logging it
 *   4. Return the response to the client
 *
 * What this proxy does NOT do:
 *   - Log, store, or inspect request bodies (transcript text, images, etc.)
 *   - Send request content to any service other than Google's Gemini API
 *   - Associate transcript content with device identifiers or license keys
 *
 * The response stream is piped through a TransformStream that scans each
 * chunk inline for the token count used in trial-budget tracking — chunks
 * pass straight to the client and the body is never buffered or copied.
 *
 * The only data logged is structured metadata: model name, feature tag, auth
 * type, a truncated identity prefix (first 8 chars), and timing in milliseconds.
 */

export interface Env {
	GEMINI_API_KEY: string;
	TRIAL_USAGE: KVNamespace;
	TRIAL_COUNTER: DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthContext {
	deviceId: string | null;
	licenseKey: string | null;
	identity: string;
	type: 'trial' | 'license';
	shortId: string;
}

export function parseAuth(request: Request): AuthContext | null {
	const deviceId = request.headers.get('X-Device-Id');
	const licenseKey = request.headers.get('X-License-Key');
	if (!deviceId && !licenseKey) return null;
	const identity = deviceId ?? licenseKey!;
	return {
		deviceId,
		licenseKey,
		identity,
		type: deviceId ? 'trial' : 'license',
		shortId: identity.slice(0, 8),
	};
}

// ---------------------------------------------------------------------------
// Token count regexes — module-level to avoid recompilation per request.
// ---------------------------------------------------------------------------

const PROMPT_TOKEN_RE = /"promptTokenCount"\s*:\s*(\d+)/;
const CANDIDATES_TOKEN_RE = /"candidatesTokenCount"\s*:\s*(\d+)/;

// ---------------------------------------------------------------------------
// Rate limiting (KV-backed, survives isolate restarts)
// ---------------------------------------------------------------------------

const MINUTE_TTL = 120; // 2× window for KV propagation safety

function currentMinuteKey(): string {
	return new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

export async function checkMinuteRateLimit(
	kv: KVNamespace,
	key: string,
	maxPerMinute: number,
): Promise<boolean> {
	const kvKey = `ratelimit:minute:${key}:${currentMinuteKey()}`;
	const current = await kv.get(kvKey);
	const count = current ? parseInt(current, 10) : 0;

	if (count >= maxPerMinute) return false;

	await kv.put(kvKey, String(count + 1), { expirationTtl: MINUTE_TTL });
	return true;
}

// ---------------------------------------------------------------------------
// Header handling
// ---------------------------------------------------------------------------

/**
 * Strip all MimicScribe-specific headers before forwarding to Google.
 * Google never receives the device identifier, license key, or feature tag.
 */
export function strippedHeaders(headers: Headers): Headers {
	const out = new Headers(headers);
	out.delete('X-Device-Id');
	out.delete('X-License-Key');
	out.delete('X-Feature');
	out.delete('X-Meeting-Id');
	out.delete('X-Local-Date');
	out.delete('Host');
	return out;
}

/**
 * Only pass through content-type and content-length from Gemini's response.
 * All other Google headers are dropped.
 */
export function filteredResponseHeaders(headers: Headers): Headers {
	const out = new Headers();
	const allowed = ['content-type', 'content-length'];
	for (const name of allowed) {
		const value = headers.get(name);
		if (value) out.set(name, value);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Model allowlist — only the models the app actually uses are proxied.
// Prevents proxying to expensive/future models. Keep in sync with the
// `GeminiModel` cases in the app (GeminiClient.swift).
// ---------------------------------------------------------------------------

const ALLOWED_MODELS = new Set(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);

// ---------------------------------------------------------------------------
// Path allowlist — only these Gemini API paths are proxied
// ---------------------------------------------------------------------------

const GEMINI_ALLOWLIST: Array<{ methods: Set<string>; re: RegExp }> = [
	{
		methods: new Set(['POST']),
		re: /^\/v1beta\/models\/[a-zA-Z0-9._-]+:generateContent$/,
	},
	{
		methods: new Set(['POST']),
		re: /^\/v1beta\/cachedContents$/,
	},
	{
		methods: new Set(['DELETE']),
		re: /^\/v1beta\/cachedContents\/[a-zA-Z0-9._-]+$/,
	},
];

function validateGeminiPath(method: string, pathname: string): boolean {
	const googlePath = pathname.replace(/^\/api\/gemini/, '');
	return GEMINI_ALLOWLIST.some(
		(rule) => rule.methods.has(method) && rule.re.test(googlePath),
	);
}

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite `/api/gemini/v1beta/models/...` to the real Google endpoint and
 * inject the server-side API key. The client never sees or sends the key.
 */
export function buildGeminiUrl(request: Request, apiKey: string): string {
	const url = new URL(request.url);
	const googlePath = url.pathname.replace(/^\/api\/gemini/, '');
	const googleUrl = new URL(
		`https://generativelanguage.googleapis.com${googlePath}`,
	);
	url.searchParams.forEach((value, name) => {
		if (name !== 'key') googleUrl.searchParams.set(name, value);
	});
	googleUrl.searchParams.set('key', apiKey);
	return googleUrl.toString();
}

// ---------------------------------------------------------------------------
// Token-counting transform
// ---------------------------------------------------------------------------

/**
 * Create a TransformStream that passes chunks through to the client unchanged
 * while scanning for `promptTokenCount` and `candidatesTokenCount` in the JSON.
 *
 * No tee, no buffering — each chunk is read once, scanned, and forwarded.
 * The returned promise resolves with the total token count when the stream
 * completes (or 0 if the counts aren't found / client disconnects early).
 */
function tokenCountingTransform(): {
	transform: TransformStream;
	tokens: Promise<number>;
} {
	let promptTokens = 0;
	let candidatesTokens = 0;
	let found = false;
	const decoder = new TextDecoder();
	let prev = '';

	let resolveTokens: (n: number) => void;
	const tokens = new Promise<number>((resolve) => {
		resolveTokens = resolve;
	});

	const transform = new TransformStream({
		transform(chunk, controller) {
			controller.enqueue(chunk);
			if (found) return;

			const text = decoder.decode(chunk, { stream: true });
			const window = prev + text;

			if (promptTokens === 0 && window.includes('"promptTokenCount"')) {
				const pm = PROMPT_TOKEN_RE.exec(window);
				if (pm) promptTokens = parseInt(pm[1], 10);
			}
			if (candidatesTokens === 0 && window.includes('"candidatesTokenCount"')) {
				const cm = CANDIDATES_TOKEN_RE.exec(window);
				if (cm) candidatesTokens = parseInt(cm[1], 10);
			}
			if (promptTokens > 0 && candidatesTokens > 0) {
				found = true;
				resolveTokens(promptTokens + candidatesTokens);
			}

			prev = window.length > 64 ? window.slice(-64) : window;
		},
		flush() {
			if (!found) resolveTokens(promptTokens + candidatesTokens);
		},
	});

	return { transform, tokens };
}

async function recordFreeUserTokens(
	tokens: number,
	deviceId: string,
	env: Env,
): Promise<void> {
	if (tokens === 0) return;
	const stub = env.TRIAL_COUNTER.get(
		env.TRIAL_COUNTER.idFromName(`trial:${deviceId}`),
	);
	await stub.fetch('https://do/', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ type: 'recordTokens', tokens }),
	});
}

// ---------------------------------------------------------------------------
// Main proxy handler
// ---------------------------------------------------------------------------

/**
 * Handle an incoming Gemini API request.
 *
 * Privacy-relevant behavior:
 *   - `request.body` is forwarded directly to Google via `fetch()`. It is
 *     never read, buffered, or logged by this worker.
 *   - `console.log` only records metadata (model, feature, auth type,
 *     truncated ID prefix, timing). No content.
 *   - The response stream is piped through a TransformStream that scans
 *     each chunk inline for `usageMetadata`. Chunks pass through to the
 *     client unchanged — the body is never buffered. Only the integer
 *     token count is retained.
 *   - The upstream fetch runs in parallel with auth/rate-limit checks for
 *     latency. Deny paths call `controller.abort()` to cancel the in-flight
 *     request.
 */
export async function handleGeminiProxy(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const reqStart = Date.now();
	const url = new URL(request.url);
	const model = url.pathname.split('/models/')[1]?.split(':')[0] ?? 'unknown';
	const auth = parseAuth(request);
	if (!auth) {
		return new Response('Unauthorized', { status: 401 });
	}
	if (!validateGeminiPath(request.method, url.pathname)) {
		return new Response('Forbidden', { status: 403 });
	}

	// Enforce the model allowlist — only the models the app actually uses.
	// Cache-management paths (/cachedContents) carry no model, so `model` is
	// 'unknown'; skip the check for them and let the path allowlist govern.
	if (model !== 'unknown' && !ALLOWED_MODELS.has(model)) {
		console.log(
			`[gemini] MODEL_BLOCKED model=${model} auth=${auth.type} id=${auth.shortId}`,
		);
		return new Response('Model not allowed', { status: 403 });
	}

	const feature = request.headers.get('X-Feature');
	const meetingId = request.headers.get('X-Meeting-Id');
	const localDate = request.headers.get('X-Local-Date');
	const isCacheManagement = url.pathname.includes('/cachedContents');

	// Trial users must provide X-Feature for non-cache requests
	if (auth.deviceId && !isCacheManagement && !feature) {
		return new Response('Missing X-Feature header', { status: 400 });
	}

	// Fire upstream fetch immediately, in parallel with auth-side checks. The
	// proxy itself never reads, buffers, or logs the body — that's the privacy
	// guarantee. Deny paths abort the in-flight request via AbortController.
	const controller = new AbortController();
	const geminiStart = Date.now();
	const geminiPromise = fetch(buildGeminiUrl(request, env.GEMINI_API_KEY), {
		method: request.method,
		headers: strippedHeaders(request.headers),
		body:
			request.method !== 'GET' && request.method !== 'HEAD'
				? request.body
				: undefined,
		signal: controller.signal,
	});

	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
	const authStart = Date.now();
	const [identityAllowed, ipAllowed, authResult] = await Promise.all([
		checkMinuteRateLimit(env.TRIAL_USAGE, `gemini:${auth.identity}`, 30),
		checkMinuteRateLimit(env.TRIAL_USAGE, `gemini-ip:${ip}`, 60),
		checkAuth(auth, feature, meetingId, localDate, isCacheManagement, env),
	]);
	const authMs = Date.now() - authStart;

	if (!identityAllowed || !ipAllowed) {
		controller.abort();
		console.log(
			`[gemini] RATE_LIMITED model=${model} auth=${auth.type} id=${auth.shortId} identity=${!identityAllowed} ip=${!ipAllowed}`,
		);
		return rateLimitedResponse();
	}

	if (!authResult.allowed) {
		controller.abort();
		console.log(
			`[gemini] AUTH_DENIED model=${model} feature=${feature} auth=${auth.type} id=${auth.shortId} authMs=${authMs} reason=${authResult.reason}`,
		);
		const code = authResult.denialCode ?? denialCodeFor(authResult.reason);
		const headers: HeadersInit = {};
		if (code) headers['X-Denial-Reason'] = code;
		if (authResult.lifetimeWarning)
			headers['X-Lifetime-Warning'] = authResult.lifetimeWarning;
		return new Response(authResult.reason ?? 'Forbidden', {
			status: 403,
			headers,
		});
	}

	let geminiResponse: Response;
	try {
		geminiResponse = await geminiPromise;
	} catch (err) {
		const geminiMs = Date.now() - geminiStart;
		const totalMs = Date.now() - reqStart;
		console.error(
			`[gemini] FETCH_ERROR model=${model} feature=${feature} auth=${auth.type} id=${auth.shortId} authMs=${authMs} geminiMs=${geminiMs} totalMs=${totalMs} error=${err instanceof Error ? err.message : 'unknown'}`,
		);
		return new Response('Upstream error', { status: 502 });
	}

	const geminiMs = Date.now() - geminiStart;
	const totalMs = Date.now() - reqStart;
	const responseHeaders = filteredResponseHeaders(geminiResponse.headers);
	responseHeaders.set('X-CF-Gemini-Ms', geminiMs.toString());
	if (authResult.lifetimeWarning) {
		responseHeaders.set('X-Lifetime-Warning', authResult.lifetimeWarning);
	}

	// Metadata-only log line — no request or response content
	console.log(
		`[gemini] OK model=${model} feature=${feature} auth=${auth.type} id=${auth.shortId} authMs=${authMs} geminiMs=${geminiMs} totalMs=${totalMs} status=${geminiResponse.status}`,
	);

	// Light licensed users: tally the meeting against the per-cycle cap, but only
	// on a successful upstream response — a failed call didn't produce a meeting.
	if (
		auth.licenseKey &&
		geminiResponse.ok &&
		authResult.licensePlan === 'light' &&
		authResult.meetingCycleId &&
		feature &&
		LIGHT_MEETING_FEATURES.has(feature)
	) {
		ctx.waitUntil(
			recordLicenseMeeting(env, auth.licenseKey, authResult.meetingCycleId),
		);
	}

	// For trial users: pipe the response through a TransformStream that scans
	// for the token count inline. Chunks pass straight to the client; only
	// the integer count is retained for lifetime budget tracking.
	if (auth.deviceId && geminiResponse.body) {
		const { transform, tokens } = tokenCountingTransform();
		const readable = geminiResponse.body.pipeThrough(transform);
		ctx.waitUntil(
			tokens.then((t) => recordFreeUserTokens(t, auth.deviceId!, env)),
		);
		return new Response(readable, {
			status: geminiResponse.status,
			headers: responseHeaders,
		});
	}

	return new Response(geminiResponse.body, {
		status: geminiResponse.status,
		headers: responseHeaders,
	});
}

// ---------------------------------------------------------------------------
// Auth helpers (simplified — production uses Durable Objects + KV)
// ---------------------------------------------------------------------------

interface AuthResult {
	allowed: boolean;
	reason?: string;
	denialCode?: string;
	lifetimeWarning?: string;
	// Light-plan meeting-cycle context, returned by checkAuth so the proxy can
	// increment the counter on a successful meeting call (only set for Light).
	licensePlan?: 'light' | 'unlimited';
	meetingCycleId?: string;
}

// ---------------------------------------------------------------------------
// Light plan: meeting count per billing cycle
// ---------------------------------------------------------------------------
//
// The Light tier is volume-capped, not feature-gated. Its product-facing limit
// is meetings per billing cycle; file imports share the pool (an imported file
// IS an AI meeting), so both features draw down the same counter. The license
// record in KV (written by the website's Stripe webhook, not this proxy) carries
// the resolved `plan` and the subscription period bounds — this proxy only reads
// them. Unlimited licenses skip all of this.

/** Must match the client's `BillingConstants.lightMeetingMonthlyCap`. */
const LIGHT_MEETING_CYCLE_CAP = 200;

/** Features that draw down the shared Light meeting allowance. */
const LIGHT_MEETING_FEATURES = new Set(['meeting', 'fileImport']);

/** Shape of the `license:<key>` KV record this proxy reads (subset). */
interface LicenseValue {
	valid: boolean;
	plan?: 'light' | 'unlimited';
	currentPeriodStart?: number;
	currentPeriodEnd?: number;
}

function currentMonthKey(): string {
	return new Date().toISOString().slice(0, 7); // YYYY-MM
}

/**
 * Cycle id for the meeting counter. Prefer the subscription anniversary
 * (`currentPeriodStart`) so the count resets with the billing cycle; fall back
 * to the calendar month when the period isn't stored (older KV records).
 */
function meetingCycleId(value: LicenseValue): string {
	if (value.currentPeriodStart && Number.isFinite(value.currentPeriodStart)) {
		return `ps${value.currentPeriodStart}`;
	}
	return currentMonthKey();
}

async function getLicenseMeetingCount(
	kv: KVNamespace,
	licenseKey: string,
	cycleId: string,
): Promise<number> {
	const raw = await kv.get(`license-meetings:${licenseKey}:${cycleId}`);
	return raw ? parseInt(raw, 10) : 0;
}

async function recordLicenseMeeting(
	env: Env,
	licenseKey: string,
	cycleId: string,
): Promise<void> {
	const k = `license-meetings:${licenseKey}:${cycleId}`;
	const current = await env.TRIAL_USAGE.get(k);
	const used = current ? parseInt(current, 10) : 0;
	await env.TRIAL_USAGE.put(k, String(used + 1), {
		// ~2 cycles of headroom so a mid-cycle gap can't expire the live count.
		expirationTtl: 70 * 24 * 3600,
	});
}

/** Map DO denial reasons to machine-readable codes for X-Denial-Reason header.
 *  License denial codes are set directly on AuthResult by checkAuth(). */
const DENIAL_CODES: Record<string, string> = {
	'Lifetime free tier budget exhausted': 'lifetime_exhausted',
	'Daily cap reached': 'daily_cap',
	'Feature requires Unlimited plan': 'pro_required',
};

function denialCodeFor(reason: string | undefined): string | undefined {
	if (!reason) return undefined;
	return (
		DENIAL_CODES[reason] ??
		(reason.startsWith('Unknown feature') ? 'unknown_feature' : undefined)
	);
}

function rateLimitedResponse(): Response {
	return new Response('Rate limited', {
		status: 429,
		headers: { 'X-Denial-Reason': 'rate_limited' },
	});
}

async function checkAuth(
	auth: AuthContext,
	feature: string | null,
	meetingId: string | null,
	localDate: string | null,
	isCacheManagement: boolean,
	env: Env,
): Promise<AuthResult> {
	if (auth.deviceId) {
		// Trial users: check against Durable Object for per-feature caps
		// and lifetime token budgets. Cache management requests only check
		// the lifetime budget (no feature increment).
		//
		// The DO call includes deviceId and meetingId so the DO can enforce
		// per-meeting caps (e.g., one summary per meeting). These values are
		// stored in the DO's transient state for cap tracking only — they are
		// not logged or sent to any external service.
		const stub = env.TRIAL_COUNTER.get(
			env.TRIAL_COUNTER.idFromName(`trial:${auth.deviceId}`),
		);
		const body = isCacheManagement
			? { type: 'checkLifetime' }
			: {
					type: 'checkAndIncrement',
					feature,
					meetingId: meetingId ?? undefined,
					deviceId: auth.deviceId,
					localDate: localDate ?? undefined,
				};
		const resp = await stub.fetch('https://do/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return resp.json();
	} else {
		// Licensed users: validate against the KV cache. The cache is populated
		// by a separate `/api/validate-license` endpoint in the production
		// website which calls the billing provider directly — that path is not
		// part of this proxy, so no third-party traffic ever originates from a
		// request that proxies transcript content.
		const value = await env.TRIAL_USAGE.get<LicenseValue>(
			`license:${auth.licenseKey}`,
			'json',
		);
		if (!value) {
			return {
				allowed: false,
				reason: 'License not validated',
				denialCode: 'license_not_validated',
			};
		}
		if (!value.valid) {
			return {
				allowed: false,
				reason: 'License invalid',
				denialCode: 'license_invalid',
			};
		}

		// Light plan: enforce the per-cycle meeting cap over the shared
		// {meeting, fileImport} pool. Unlimited skips this entirely.
		const plan = value.plan ?? 'unlimited';
		if (plan !== 'light') return { allowed: true };

		const cycleId = meetingCycleId(value);
		if (feature && LIGHT_MEETING_FEATURES.has(feature)) {
			const used = await getLicenseMeetingCount(
				env.TRIAL_USAGE,
				auth.licenseKey!,
				cycleId,
			);
			if (used >= LIGHT_MEETING_CYCLE_CAP) {
				return {
					allowed: false,
					reason: 'Monthly meeting limit reached',
					denialCode: 'monthly_cap_reached',
					licensePlan: 'light',
					meetingCycleId: cycleId,
				};
			}
		}
		// Allowed — hand back the cycle context so the proxy can increment on success.
		return { allowed: true, licensePlan: 'light', meetingCycleId: cycleId };
	}
}
