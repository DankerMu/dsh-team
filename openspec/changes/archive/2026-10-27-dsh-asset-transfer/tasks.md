## Risk packs

- **Config / project setup — selected.** One overlay option on the `webserver` row. Tasks 1.1 and 1.2.
- **Error handling / rollback / partial outputs — selected.** A cache header on the wrong response (an error page, HTML, an unhashed or query-bearing URL) would persist in browsers for a year and cannot be recalled. Task 1.4 rejects every such case. A wrong overlay value fails DSH's boot-time schema validation, so every Docker lane fails loudly.
- **Legacy compatibility / examples — selected.** Clients that send no `Accept-Encoding` still get identity bytes; SSE and WebSocket behave as before; every Docker lane that uses the generated overlay (orchestrator start, deployment, first-use, admin activation, model lanes) boots DSH with it. Lanes that hand-write their own overlay (`user-image-fixture.ts:461`, `web-startup.integration.test.ts:66`, `managed-policy-fixture.ts:386`) are unchanged and do not exercise gzip. Tasks 1.2 and 2.2.
- **Resource limits / large input — selected.** The 10 MB combined script is the case being optimised; its decoded bytes must equal the identity response. Task 1.2.
- **Documentation / migration notes — selected.** Task 1.3. Running instances pick it up at their next start (existing overlay semantics), stated there.
- **Not selected:**
  - Public API, schema/DB, auth: untouched; `private` keeps authenticated responses out of shared caches.
  - File IO: none.
  - Concurrency: none added; per-response CPU at level 1 is DSH's own design.

## Must preserve

- The rest of the `webserver` row (`host: '0.0.0.0'`, `port: 3080`) and every other overlay row, byte-for-byte apart from the new field.
- Gateway forwarding is unchanged for every response outside the cache predicate: same status, headers (minus hop-by-hop and `set-cookie`, as today) and streamed body (`platform/src/gateway/http.ts:107-113`). WebSocket forwarding is untouched.
- Existing exact-row assertions that change with the new field (updated, not weakened): `platform/src/managed-config/generate.test.ts` and `platform/test/container-start.docker.test.ts:144-147` (`webserver` row `toContainEqual`).
- `/plugins/events` stays an uncompressed `text/event-stream` that delivers its first `graph` frame; WebSocket upgrades unchanged.
- No new browser console errors in any Docker lane.

## 1. Implementation

- [x] 1.1 `platform/src/managed-config/generate.ts`: `webserver` row config `{ host: '0.0.0.0', port: 3080, compression: 'gzip' }`.
- [x] 1.2 Tests (write first, see them fail):
  - `generate.test.ts`: exact `webserver` row including `compression: 'gzip'`;
  - `container-start.docker.test.ts:144-147`: the exact `webserver` row gains `compression: 'gzip'`;
  - one existing Docker lane that already reaches native DSH through the real platform gateway (prefer `platform/test/deployment.docker.test.ts`, which `test:deploy` and full `test:docker` both run): use `node:http.request` or the lane's existing raw-socket helpers, never `fetch` (it adds `Accept-Encoding` itself and decodes silently). With the employee session cookie, request the combined plugin script named in the native HTML three times, setting the header explicitly each time:
    - `Accept-Encoding: gzip` → `Content-Encoding: gzip`; the gunzipped bytes equal the identity body below;
    - `Accept-Encoding: identity` → no `Content-Encoding`;
    - no `Accept-Encoding` header → no `Content-Encoding`, same bytes as identity;
    - `GET /plugins/events` with `Accept-Encoding: gzip` → `content-type: text/event-stream`, no `Content-Encoding`; the first `data:` frame (after the `: connected` comment) parses as `{"type":"graph",...}`; close the stream afterwards.
- [x] 1.3 Docs (gzip and the #370 asset cache header): one sentence in AGENTS.md `### Compose deployment verification`, paragraph starting "Required evidence is actual health200" (gzip transfer through the gateway is part of the native-entry evidence), and in `docs/DEPLOY.md` step 4 of the post-install list (~line 134): DSH pages are served gzip-compressed, applying at each instance's next start.

- [x] 1.4 Gateway cache header (#370), tests first.
  - **Predicate input.** One exported pure function in `http.ts` beside `forwardHeaders`, taking the method, the raw request target (`incoming.raw.url`, undecoded, query included), the upstream status and the forwarded header map. It matches the raw target against `^/assets/(?:[a-z]+/)?[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2|woff|ttf)$`. The name class allows `-` and `_` and excludes `%`, `.` and `/`, and any `?` fails the match. No new module.
  - **Unit test (`platform/src/gateway/http.test.ts`, pure predicate):**
    - true for GET and HEAD 200 of `/assets/index-5SrrfWpU.js`, `/assets/vendor-BNsW4eBh.css`, `/assets/fonts/KaTeX_AMS-Regular-BQhdFMY1.woff2` and `/assets/langs/bibtex-CHM0blh-.js` (a hash containing `-`);
    - false for: POST; `?x=1`; a bare `?`; status 404 or 304; an upstream that already sends `cache-control`; `/`; `/index.html`; `/manifest.webmanifest`; `/favicon.svg`; `/assets/index.js` (no hash); `/assets/index-5SrrfW.js` (short hash); `/assets/a/b/x-12345678.js` (two directories); `/assets/Fonts/x-12345678.woff2` (uppercase directory); `/assets/%2e%2e/x-12345678.js` (encoded traversal); `/assets/x-12345678.map`; `/plugins/??...client.js&rev=...`; `/plugins/events`; `/api/session/list`.
  - **Integration test (`platform/test/gateway-http.integration.test.ts`, real upstream and real Fastify forwarding via `withUpstream`/`withForwardingApp`/`sendHttp`):**
    - a hashed asset with upstream 200 gains exactly the header; every other upstream header and the body bytes are unchanged;
    - HEAD gains the header and has no body;
    - an upstream `cache-control` is kept as sent;
    - a non-matching path and a 404 on a matching path are forwarded exactly as before.
- [x] 1.5 Docker (same lane and transport as 1.2): the `/assets/index-*.js` named in the native HTML carries the header; the native HTML and `/plugins/events` do not; the combined plugin script keeps DSH's own `public, max-age=31536000, immutable`.

## 2. Verification

- [x] 2.1 `pnpm check` (includes `pnpm test:integration`)
- [x] 2.2 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`; CI green.

## Non-goals

- No compression level/threshold tuning, brotli or precompression.
- No cache header for HTML or unhashed resources; no ETag/304 negotiation.
- The first-load duplicate download (DSH's own loader fallback; findings on #369).
