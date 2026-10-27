## Risk packs

- **Config / project setup — selected.** One overlay option on the `webserver` row. Tasks 1.1 and 1.2.
- **Legacy compatibility / examples — selected.** Clients that send no `Accept-Encoding` still get identity bytes; SSE and WebSocket behave as before; every existing Docker lane boots DSH with the new overlay. Tasks 1.2 and 2.2.
- **Resource limits / large input — selected.** The 10 MB combined script is the case being optimised; its decoded bytes must equal the identity response. Task 1.2.
- **Documentation / migration notes — selected.** Task 1.3. Running instances pick it up at their next start (existing overlay semantics), stated there.
- **Not selected:**
  - Public API, schema/DB, auth: untouched.
  - File IO: none.
  - Concurrency: none added; per-response CPU at level 1 is DSH's own design.
  - Error handling: DSH validates the option at boot; a wrong value fails every Docker lane loudly.

## Must preserve

- The rest of the `webserver` row (`host: '0.0.0.0'`, `port: 3080`) and every other overlay row, byte-for-byte apart from the new field.
- Gateway forwarding is untouched (`platform/src/gateway/http.ts`).
- `/plugins/events` stays an uncompressed `text/event-stream` that delivers its first `graph` frame; WebSocket upgrades unchanged.
- No new browser console errors in any Docker lane.

## 1. Implementation

- [ ] 1.1 `platform/src/managed-config/generate.ts`: `webserver` row config `{ host: '0.0.0.0', port: 3080, compression: 'gzip' }`.
- [ ] 1.2 Tests (write first, see them fail):
  - `generate.test.ts`: exact `webserver` row including `compression: 'gzip'`;
  - one existing Docker lane that already reaches native DSH through the real platform gateway (prefer `platform/test/deployment.docker.test.ts`, which `test:deploy` and full `test:docker` both run): request the combined plugin script named in the native HTML with `Accept-Encoding: gzip` → `Content-Encoding: gzip`, gunzipped bytes equal the same URL fetched with `Accept-Encoding: identity` (which has no `Content-Encoding`); `GET /plugins/events` → `content-type: text/event-stream`, no `Content-Encoding`, first `data:` frame parses as `{"type":"graph",...}`.
- [ ] 1.3 Docs: the AGENTS.md / DEPLOY.md overlay description mentions gzip and that it applies at the next instance start.

## 2. Verification

- [ ] 2.1 `pnpm check`
- [ ] 2.2 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`; CI green.

## Non-goals

- No compression level/threshold tuning, brotli or precompression.
- No cache-header change for DSH `/assets/*` (recorded on #369 for a separate decision).
- The first-load duplicate download (DSH's own loader fallback; findings on #369).
