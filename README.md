# MimicScribe Gemini API Proxy

This is the Cloudflare Worker that sits between the [MimicScribe](https://mimicscribe.app) desktop app and Google's Gemini API. The code is published here so you can see exactly what happens to your data in transit.

## What this proxy does

1. **Authenticates** the request (trial device ID hash or license key)
2. **Strips all identity headers** (`X-Device-Id`, `X-License-Key`, `X-Feature`, `X-Meeting-Id`, `X-Local-Date`) before forwarding to Google
3. **Forwards the request body directly** to `generativelanguage.googleapis.com` without reading, buffering, or logging it
4. **Returns the response** to the client, passing through only `content-type` and `content-length` headers

## What gets logged

The only `console.log` output is a structured metadata line per request:

```
[gemini] OK model=gemini-2.0-flash-001 feature=fusion auth=trial id=a1b2c3d4 authMs=12 geminiMs=834 totalMs=846 status=200
```

No request body, response body, or transcript content appears in logs.

## Data flow

```
MimicScribe App
    |
    |  POST /api/gemini/v1beta/models/gemini-2.0-flash:generateContent
    |  Headers: X-Device-Id, X-Feature, Content-Type
    |  Body: { transcript text, prompt }
    |
    v
+------------------------------------------+
|  This Cloudflare Worker                  |
|                                          |
|  1. Parse auth from headers              |
|  2. Validate path against allowlist       |
|  3. Rate limit (30/min + 60/min per IP)  |
|  4. Check trial/license caps via DO/KV   |
|  5. DELETE identity headers              |
|  6. Forward request body to Google       |
|  7. Return response to client            |
|                                          |
|  Steps 1–4 complete before step 6 — a    |
|  denied request never reaches Google.    |
|  Request body is never read or logged.   |
+------------------------------------------+
    |
    |  POST https://generativelanguage.googleapis.com/...
    |  Headers: Content-Type (identity headers removed)
    |  Body: unchanged from client
    |
    v
Google Gemini API
```

## Trial token counting

For free-tier users, the Gemini response body is piped through a `TransformStream` that scans each chunk inline as it passes through to the client. The chunks are forwarded unchanged — the response body is never buffered, never copied, never inspected for content. When `usageMetadata` is found, only the integer token count (`promptTokenCount` + `candidatesTokenCount`) is extracted and recorded to a Durable Object for lifetime budget tracking.

Licensed users in this open-source extract are not scanned. Production additionally tracks a monthly token budget for licensed users, which adds the same inline-scan logic to the licensed-user response path; the privacy guarantee is the same — chunks pass through unchanged and only the integer count is retained.

## Durable Object state

For trial users, the `checkAndIncrement` call to the Durable Object includes the `deviceId` and `meetingId` (if present). The DO uses these to enforce per-meeting caps (e.g., one summary per meeting per device). These identifiers are stored in the DO's transient state for cap tracking only — they are not logged or sent to any external service. The DO does not receive or store any transcript content.

## Production differences

This repository contains the Gemini proxy logic extracted from our production SvelteKit deployment. The production version is integrated into our website's Cloudflare Workers setup. The core proxy behavior — header stripping, request body forwarding, response handling, and logging — is identical to what you see here.

The production Worker also serves separate endpoints for license validation (Stripe), checkout, analytics, and crash diagnostics. These endpoints are not part of the Gemini proxy path and are not included in this repository. License validation specifically runs from a dedicated `/api/validate-license` endpoint triggered by the client — not from the proxy path itself, so no third-party traffic ever originates from a request that proxies transcript content.

Production additionally tracks a monthly token budget for licensed users (this extract does not). The privacy property is the same as for the trial path — chunks pass through unchanged and only the integer token count is retained.

## License

MIT
