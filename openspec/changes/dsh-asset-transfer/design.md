## Change surface

- `platform/src/managed-config/generate.ts`: `webserver` row config.
- `platform/src/gateway/http.ts` `forwardHttp` response callback: one cache predicate applied to the forwarded header map.

## Must preserve

See `tasks.md`, "Must preserve". In short: every response outside the predicate is forwarded byte-for-byte as today; SSE and WebSocket are untouched; identity clients still get identity bytes.

## Must add / change

- DSH gzip on via the overlay (DSH's own middleware, level 1, threshold 1024, SSE/Range excluded by DSH's filter).
- `Cache-Control: private, max-age=31536000, immutable` on GET/HEAD 200 responses for Vite-hashed DSH assets without a query string, only when the upstream sent no `Cache-Control`.

## Governing invariant

The platform never changes what a DSH response contains, and it marks a response as cacheable forever only when its URL is a content hash of its bytes.

## Sibling surfaces

- **DSH static serving** (`dsh-web-frontend/dist/assets/`): 4 top-level hashed js/css, `fonts/` 63 hashed font files, `langs/` 59 hashed js. The predicate is derived from these names; anything DSH adds later outside the pattern stays uncached (safe default). The pattern is a heuristic: an unhashed file whose last dash segment happens to be 8 base64url characters (for example `x-features.css`) would also match. No such file exists in the installed DSH dist (of the 126 files under `assets/`, 125 are Vite-hashed and match; the remaining `fonts/Montserrat-OFL.txt` licence text does not match and stays uncached; checked against the 0.2.0-rc.2 package); a DSH upgrade must re-check this, which the user-image base-update procedure already requires for the whole image.
- **DSH plugin bundles** (`/plugins/??...&rev=`): already `public, max-age=31536000, immutable` from DSH; the predicate does not match them and the upstream header is kept.
- **DSH HMR SSE** (`/plugins/events`): not matched, not compressed (DSH filter).
- **Gateway WebSocket path**: separate function, untouched.
- **Platform's own `/_platform/assets/*`**: served by Fastify static, never reaches `forwardHttp`; out of scope.

## Seams under test

- The pure cache predicate in `http.test.ts` (that harness mocks `node:http.request` with a fixed 401, so it cannot vary status or upstream headers).
- `forwardHttp` header-map behaviour in `platform/test/gateway-http.integration.test.ts` with a real upstream and the real Fastify forwarding.
- `generateManagedConfig` exact rows.
- Real DSH through the real platform gateway in `deployment.docker.test.ts`, over `node:http`/raw sockets.

## Non-goals

See `tasks.md`.

## Review focus

1. The predicate cannot match a non-hashed, query-bearing, non-200 or non-GET/HEAD response.
2. Header map handling: upstream `cache-control` wins; no other header changes; HEAD keeps working.
3. gzip end to end through `response.pipe(reply.raw)`: `Content-Encoding`/`Vary` passed, no `Content-Length` mismatch.
4. The Docker evidence uses explicit `Accept-Encoding` over `node:http`, not `fetch`.
