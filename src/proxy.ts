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
 * Note: For trial users, the response stream is scanned chunk-by-chunk to
 * extract token counts for lifetime budget tracking. Each chunk is discarded
 * immediately — the full response is never buffered. See recordFreeUserTokens().
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
// Rate limiting (in-memory, per-isolate)
// ---------------------------------------------------------------------------

const rateLimiter = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, maxPerMinute: number): boolean {
	const now = Date.now();
	const entry = rateLimiter.get(key);
	if (!entry || now > entry.resetAt) {
		if (!entry) {
			for (const [k, v] of rateLimiter) {
				if (now > v.resetAt) rateLimiter.delete(k);
			}
		}
		rateLimiter.set(key, { count: 1, resetAt: now + 60_000 });
		return true;
	}
	if (entry.count >= maxPerMinute) return false;
	entry.count++;
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
 *   - For trial users, the response stream is teed and scanned
 *     chunk-by-chunk for `usageMetadata`. Each chunk is discarded
 *     immediately after scanning — the full response is never buffered.
 *     Only the integer token count is retained.
 *     Licensed users are not affected (no tee, no scanning).
 */
export async function handleGeminiProxy(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const reqStart = Date.now();
	const url = new URL(request.url);
	const model =
		url.pathname.split('/models/')[1]?.split(':')[0] ?? 'unknown';
	const auth = parseAuth(request);
	if (!auth) {
		return new Response('Unauthorized', { status: 401 });
	}
	if (!checkRateLimit(`gemini:${auth.identity}`, 30)) {
		console.log(
			`[gemini] RATE_LIMITED model=${model} auth=${auth.type} id=${auth.shortId}`,
		);
		return new Response('Rate limited', { status: 429 });
	}

	const feature = request.headers.get('X-Feature');
	const meetingId = request.headers.get('X-Meeting-Id');
	const localDate = request.headers.get('X-Local-Date');
	const isCacheManagement = url.pathname.includes('/cachedContents');

	// Fire off the upstream request immediately (auth check runs in parallel)
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

	// Auth check (trial users → Durable Object, licensed users → KV)
	const authStart = Date.now();

	// Trial users must provide X-Feature for non-cache requests
	if (auth.deviceId && !isCacheManagement && !feature) {
		controller.abort();
		return new Response('Missing X-Feature header', { status: 400 });
	}

	const authResult = await checkAuth(
		auth,
		feature,
		meetingId,
		localDate,
		isCacheManagement,
		env,
	);
	const authMs = Date.now() - authStart;

	if (!authResult.allowed) {
		controller.abort();
		console.log(
			`[gemini] AUTH_DENIED model=${model} feature=${feature} auth=${auth.type} id=${auth.shortId} authMs=${authMs} reason=${authResult.reason}`,
		);
		return new Response(authResult.reason ?? 'Forbidden', { status: 403 });
	}

	// Background revalidation for licensed users — refresh KV cache
	// periodically so auth doesn't go stale between Polar checks.
	if (auth.licenseKey) {
		ctx.waitUntil(revalidateLicenseInBackground(auth.licenseKey, env));
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

	// For trial users: tee the stream to count tokens for lifetime budget
	// tracking. Only the integer token count is recorded — text is discarded.
	if (auth.deviceId && geminiResponse.body) {
		const [clientStream, countingStream] = geminiResponse.body.tee();
		ctx.waitUntil(recordFreeUserTokens(countingStream, auth.deviceId, env));
		return new Response(clientStream, {
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
	lifetimeWarning?: string;
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
		// Licensed users: validate against KV cache
		const value = await env.TRIAL_USAGE.get<{ valid: boolean }>(
			`license:${auth.licenseKey}`,
			'json',
		);
		if (!value?.valid) {
			return { allowed: false, reason: 'License not validated' };
		}
		return { allowed: true };
	}
}

/**
 * Periodically re-validate a license key against the upstream provider
 * (Polar) so that the KV cache stays fresh. Throttled to once per 2 hours.
 */
async function revalidateLicenseInBackground(
	licenseKey: string,
	env: Env,
): Promise<void> {
	const throttleKey = `license-revalidated:${licenseKey}`;
	const existing = await env.TRIAL_USAGE.get(throttleKey);
	if (existing) return;
	await env.TRIAL_USAGE.put(throttleKey, '1', { expirationTtl: 2 * 3600 });
	try {
		// In production, this calls the Polar API to check license status
		// and updates the KV cache accordingly. The license key is the only
		// data sent — no transcript content or device information.
		const resp = await fetch(
			'https://api.polar.sh/v1/customer-portal/license-keys/validate',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key: licenseKey }),
			},
		);
		if (resp.ok) {
			const result = await resp.json<{ status?: string; customer_id?: string }>();
			const valid =
				!!result.status &&
				result.status !== 'revoked' &&
				result.status !== 'disabled';
			if (valid) {
				await env.TRIAL_USAGE.put(
					`license:${licenseKey}`,
					JSON.stringify({ valid: true, customerId: result.customer_id }),
					{ expirationTtl: 10800 },
				);
			} else {
				await env.TRIAL_USAGE.delete(`license:${licenseKey}`);
			}
		}
	} catch {
		// Revalidation is best-effort — failures are silently ignored
	}
}

// ---------------------------------------------------------------------------
// Token counting for trial budget tracking
// ---------------------------------------------------------------------------

/**
 * Scan a Gemini response stream chunk-by-chunk to extract the token count
 * from usageMetadata, then record it to the DO for lifetime tracking.
 *
 * Each chunk is discarded immediately after scanning — only the integer
 * token counts are retained. The full response is never buffered in memory.
 */
async function recordFreeUserTokens(
	stream: ReadableStream,
	deviceId: string,
	env: Env,
): Promise<void> {
	// Match each count independently — handles any key ordering and nested
	// objects (candidatesTokensDetail, etc.) that contain inner braces.
	const PROMPT_RE = /"promptTokenCount"\s*:\s*(\d+)/;
	const CANDIDATES_RE = /"candidatesTokenCount"\s*:\s*(\d+)/;
	let promptTokens = 0;
	let candidatesTokens = 0;
	try {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		// Keep tail of previous chunk to handle values split across boundaries.
		let prev = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			const window = prev + chunk;
			const pm = PROMPT_RE.exec(window);
			const cm = CANDIDATES_RE.exec(window);
			if (pm) promptTokens = parseInt(pm[1], 10);
			if (cm) candidatesTokens = parseInt(cm[1], 10);
			if (pm && cm) {
				// Found both counts — drain remaining chunks without storing
				for (;;) {
					const { done: d } = await reader.read();
					if (d) break;
				}
				break;
			}
			// Keep last 64 chars for boundary overlap — individual key:value
			// pairs are short, so a small overlap suffices.
			prev = window.length > 64 ? window.slice(-64) : window;
		}
	} catch {
		return;
	}
	const tokens = promptTokens + candidatesTokens;
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
