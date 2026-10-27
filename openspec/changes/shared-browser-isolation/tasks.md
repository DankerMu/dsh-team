## Risk packs

- **Auth / permissions / secrets — selected.** Cross-user influence on a shared origin, Service Worker phishing of the login page, shadowing session cookies locking out platform APIs, and the HttpOnly session surviving clearing and healing (no `Path=/` expiry). Tasks 1.2, 1.3, 1.4, 1.5.
- **Public API / protocol / HTTP semantics — selected.** `Vary` merging on every forwarded response; 403 on `Service-Worker`; extra `Set-Cookie` only on duplicate-session requests; no other header, status or body change. Tasks 1.1, 1.2, 1.3.
- **Legacy compatibility / migration — selected.** Entries cached and workers registered before the upgrade are not covered by `Vary` or the 403. The covering upgrade step is documented in task 1.8, and post-login unregistration is in task 1.4.
- **Performance / caching — selected.** #370's gain is kept within a session at the cost of one cold load per login. Tasks 1.1 and 2.2 (acceptance measurement).
- **Concurrency / multi-tab — selected.** A blocked IndexedDB deletion must not stall navigation (task 1.4). Pages of A's still running in a tab or restored by bfcache are a documented exception (task 1.8).
- **Error handling / partial outputs — selected.** Clearing failures never block or alter the single navigation. Tasks 1.4, 1.5.
- **Resource limits — selected, documentation only.** Cookie bombs exceeding Node's header limit (431) cannot be healed by the application; this is documented in task 1.8.
- **Documentation — selected.** Task 1.8.
- **Not selected:**
  - schema/migration: no data change;
  - config: no new input;
  - release/packaging: no image, bundle or Compose change;
  - critical paths: none touched.

## Must preserve

See `design.md`, "Must preserve".

## 1. Implementation (tests first)

- [x] 1.1 Gateway `Vary`:
  - Unit tests of the merge function:
    - absent → `Cookie`;
    - `Accept-Encoding` → `Accept-Encoding, Cookie`;
    - `cookie` → `cookie`;
    - `Accept-Encoding,COOKIE` → unchanged;
    - `*` and `Accept-Encoding, *` → unchanged;
    - `X-Cookie-Foo` → `X-Cookie-Foo, Cookie`.
  - Gateway integration over real HTTP: these responses reach the client with the merged `Vary`, and status, other headers and body are unchanged:
    - a forwarded 200 HTML;
    - a hashed asset that still gains the #370 header;
    - a 301;
    - a 404;
    - an upstream `Vary: Accept-Encoding` response.
  - Unchanged: `/_platform/*` responses, the gateway's anonymous redirect, the wait redirect, 503 and WebSocket 101.
- [x] 1.2 Gateway `Service-Worker` refusal, integration:
  - an admitted GET with `Service-Worker: script` → 403 JSON, and the upstream records no request;
  - the same request without the header → forwarded;
  - an anonymous request keeps today's admission behaviour.
- [x] 1.3 Heal hook:
  - Unit tests of the shared cookie-form function:
    - an IPv4 or IPv6 host gives host-only only;
    - `dsh.corp.example` gives host-only plus `Domain=dsh.corp.example` and `Domain=corp.example`;
    - HTTPS adds `Secure` and `Partitioned; Secure` variants.
  - Unit tests of the path set:
    - `/_platform/api/login` gives exactly `/_platform`, `/_platform/`, `/_platform/api`, `/_platform/api/`, `/_platform/api/login` and `/_platform/api/login/`;
    - `/_platform/api/login/?x=1` gives the same set;
    - `/` gives no non-root path;
    - `/foo` gives `/foo` and `/foo/`;
    - `Path=/` appears only in `Domain` forms, and only for DNS hosts.
  - Integration, rejected WebSocket upgrade: a duplicate-cookie upgrade gets the 401 raw response plus the expiry headers, and a single-cookie one gets no extra headers.
  - Integration (real app over HTTP):
    - a duplicate-cookie request to `/_platform/api/session` gives 401 plus the expiry headers and no `Path=/`;
    - a duplicate-cookie login gives 200 with the new session cookie plus the expiry headers;
    - a single-cookie request gets no extra headers;
    - a duplicate-cookie gateway path gets today's anonymous answer plus the expiry headers;
    - a login or registration request that carries a single `platform_session` gets the expiry headers alongside its new session cookie.
- [x] 1.4 Web clearing module, with a sibling unit test (jsdom plus stubs):
  - every store in the spec is cleared;
  - cookie expiries are written for every ancestor path including `/`, in every cookie form (IP vs DNS host, HTTP vs HTTPS);
  - missing `indexedDB.databases`, `navigator.serviceWorker` and `caches` are skipped;
  - a throwing step does not stop later steps or reject;
  - a `deleteDatabase` that settles via `blocked` resolves.
- [x] 1.5 Call sites:
  - `account-page.tsx`: login 200 and registration 201 call the module after the body is consumed and before the single `location.assign('/')`.
  - `password-page.tsx`: logout 204 calls it before `location.assign('/_platform/login')`; password change does not.
  - Failure responses never call it.
  - Page unit tests assert the order "body consumed → cleared → navigated once", and that a rejected clearing still navigates once.
- [x] 1.6 Two-user Playwright test `platform/test/shared-browser.ui.test.ts`, and the `AccountUiOptions` upstream-handler option (default unchanged). Covers scenarios 1 (persistent-context restart) and 2 exactly as in `design.md` §6, with no request interception, and runs the closing-A's-tabs diagnostic: gating scenario 3 if it is green, otherwise a recorded result.
  - Run first against the unchanged gateway, auth and pages, and record the RED failures:
    - Service Worker registration (after the plain pre-warm fetch, with `updateViaCache: 'all'`) succeeds;
    - marker `A`, with no phase-B script request;
    - storage, database, cache and cookie present;
    - session read 401 (no heal).
  - Then GREEN. The Service Worker 403 console error is asserted as an exact expected message.
- [x] 1.7 `verifyAssetTransfer` asserts that `Vary` contains exactly one `cookie` token (case-insensitive) on the native HTML, the hashed entry script, the combined plugin script (identity and gzip requests) and `/plugins/events`. It makes no claim about DSH's other tokens; tasks 1.1 prove those are preserved.
- [x] 1.8 Docs:
  - `docs/DEPLOY.md` §4: the cold load after each login.
  - `docs/DEPLOY.md` upgrade note: clear browsing data once in shared profiles after deploying, since pre-upgrade cache entries and workers are unprotected.
  - `docs/DEPLOY.md` §6 residual risks:
    - one's own session;
    - a page of A's still open, or restored by Back from bfcache;
    - a shadowing cookie on a path the login request does not carry costs one 401 and one return to the login page;
    - cookie bombs (431) need a site-data clear, as do shadowing cookies on a WebSocket-only path if the browser ignores cookies on a rejected handshake;
    - one profile per person, and log out and close the browser on handover.
  - AGENTS.md: the gateway forwarding sentence (`Vary` merge, `Service-Worker` 403), a session-cookie sentence (duplicate heal, no `Path=/`) and the platform-UI form sentence (clearing before navigation).

## 2. Verification

- [ ] 2.1 `pnpm check`; `pnpm test:ui` with the new suite.
- [ ] 2.2 Exact-head VPS `pnpm test:docker` with confirmed cleanup, and `pnpm test:deploy` with the `Vary` assertion on real DSH; CI green. After merge, redeploy the acceptance environment and measure a repeat load within one session (gain kept) and the first load after a new login.

## Non-goals

See `design.md`.
