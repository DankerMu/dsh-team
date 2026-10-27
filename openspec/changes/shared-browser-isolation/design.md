## Change surface

- `platform/src/gateway/http.ts`, `forwardHttp` response callback: after `forwardHeaders(...)` and the `isImmutableAsset` decision, before `writeHead`, set `vary` through one exported pure function (for example `withCookieVary(value)`).
- `platform/src/gateway/routes.ts`, before `forwardHttp` is called for an admitted request: a request carrying the `Service-Worker` request header gets a sanitized 403 JSON and is not forwarded.
- `platform/src/auth/`, one new root `onRequest` hook registered in `app.ts` before the route plugins, plus one pure function. When the request's `Cookie` header carries more than one `platform_session` pair, the hook appends expiry `Set-Cookie` headers for the shadowing paths (decision 3). It does not change admission: `readSessionCookie` still treats the request as having no session.
- `platform/web/src/`, one new module (for example `origin-state.ts`) exporting one async function. It is called from:
  - `account-page.tsx`, on login 200 and registration 201, after `settleBody` and before `window.location.assign('/')`;
  - `password-page.tsx`, on logout 204, after consuming the body and before `window.location.assign('/_platform/login')`.

  Password change (204) does not call it: the user is the same.

- `platform/test/account-ui-fixture.ts`: `AccountUiOptions` gains an optional upstream request handler. When it is absent, the existing plain-text handler and `upstreamRequests` recording are unchanged. When present, the fixture still records every request in `upstreamRequests` before delegating. The new suite passes `/_platform/api/session` among the observer's tracked endpoints (`observeAccountUi` `credentialUrl` list) so its reads are not reported as unexpected.
- New `platform/test/shared-browser.ui.test.ts`.
- `platform/test/deployment-asset-transfer-fixture.ts`, `verifyAssetTransfer`: extended in place.

## Decisions

### 1. Per-session HTTP cache through `Vary: Cookie`, not `no-store` or URL rewriting

- `no-store` would discard #370's measured gain (repeat load 2.1 s → 0.17 s) even within one session.
- Per-user URLs would need DSH to emit different asset URLs, which means changing DSH source (D1).
- `Vary: Cookie` keys each cache entry by the browser's own `Cookie` request header, which always includes the HttpOnly `platform_session`. That token differs per user and per login, and is stable within a session.

`Vary` is applied to every forwarded HTTP response, not only cacheable ones. A chooses the status and caching headers, including heuristic freshness and permanent redirects, so a selective rule could be bypassed.

Merging. The required tokens are `Cookie` and `Service-Worker` (decision 2):

- absent → `Cookie, Service-Worker`;
- present → the original value, then each required token that is missing (case-insensitive, comma-separated, optional spaces), appended in that order;
- containing `*` → unchanged.

Node presents `vary` as one comma-joined string.

**Known uncertainty, decided by the test.** Chromium also has the Blink in-renderer memory cache. Its `Vary` check compares only headers on Blink's own request, which lacks `Cookie`. The real Chromium two-user test settles whether a same-origin navigation can serve A's script to B from that cache. If the test stays red after all changes, the implementer stops and reports; a further mechanism needs a fixture revision.

**Entries cached before the upgrade** carry no `Vary` and are not protected; script cannot clear the HTTP cache. `docs/DEPLOY.md` therefore gains an upgrade step: after deploying, clear browsing data in every shared browser profile once.

### 2. No Service Worker registration through the gateway

On an HTTPS origin, or on `http://127.0.0.1`/`localhost`, A's workbench could register a Service Worker whose script A serves at `/`, with scope `/`. That worker would control `/_platform/login`: it could fake the login page, read B's password, or drop the post-login clearing. Unregistering after login is too late.

Browsers send the `Service-Worker: script` request header on every Service Worker script fetch, both registration and update checks. DSH 0.2.0-rc.2 uses no Service Worker (#372 investigation). So the gateway refuses to forward any request carrying a `Service-Worker` header, with 403.

**Pre-warmed cache bypass.** A could first `fetch('/sw.js')` without the header, which is forwarded and cached, and then call `register('/sw.js', { updateViaCache: 'all' })` so that the script is read from the HTTP cache. To close that, the gateway also merges `Service-Worker` into `Vary` (decision 1). An entry cached by a request without the header then cannot satisfy a request with it. The Playwright RED/GREEN includes this pre-warm attempt. Registration then fails, and an already-registered worker can no longer update from the instance.

The platform's own `/_platform` paths are not forwarded and serve no worker script.

Workers registered before the upgrade are covered by the post-login and post-logout unregistration, and by the upgrade step of clearing browsing data.

### 3. Server heal for shadowing `platform_session` cookies

The attack: A's script plants a non-HttpOnly `platform_session=<anything>` at a deeper path, for example `/_platform/api`.

- `readSessionCookie` sees two pairs and fails closed, so this cannot impersonate.
- But it locks every later user out of every platform API: the wait page's start request returns 401, which sends the user back to login, in a loop.
- Script on `/_platform/login` or `/_platform/account` cannot see that path, so client clearing cannot reach it.

**Heal rule.** A cookie is sent only when its path path-matches the request path. So every shadowing cookie in a request is at an ancestor of the request path, with or without a trailing slash. When the `Cookie` header carries more than one `platform_session` pair, the response appends `platform_session=; Max-Age=0` for each non-root ancestor `P` of the request path, including the path itself:

- with `Path=P` and with `Path=P/`;
- each in every cookie form (below).

When the public hostname is a DNS name, the response also expires `Path=/` in every `Domain` form. Those forms remove only domain cookies, never the host-only legitimate session.

**Cookie forms**, shared by the server heal and the client clearing:

- host-only;
- when the hostname is a DNS name (not an IPv4 or IPv6 literal): `Domain=<d>` for the hostname and for each of its parent domains up to, but excluding, the last label. A browser rejects a public-suffix domain anyway, so an extra form is harmless.
- when the origin is HTTPS (`PLATFORM_COOKIE_SECURE` on the server, `location.protocol` in the page): every form above, also with `Secure`, and with `Partitioned; Secure`. Chromium keeps partitioned cookies separately, so an unpartitioned expiry does not remove them.

Ancestors are computed from the request path with the query removed. A trailing slash on the request path does not add an empty segment.

**WebSocket upgrades** do not pass through Fastify `onRequest`: `app.server.on('upgrade')` and `rejectUpgrade` write raw responses (`platform/src/gateway/routes.ts`). A shadowing cookie placed only on DSH's WebSocket path would never be healed by an HTTP request. So when an upgrade is rejected and its `Cookie` header carries duplicates, the raw rejection carries the same expiry headers. Whether Chromium stores cookies from a non-101 WebSocket handshake response is not established. The integration test proves the headers; if Chromium ignores them, the documented remedy is a site-data clear.

Example: for `/_platform/api/login` the paths are `/_platform`, `/_platform/`, `/_platform/api`, `/_platform/api/`, `/_platform/api/login`, `/_platform/api/login/`.

`Path=/` is never emitted:

- With an IP host, a browser may store a matching `Domain` cookie as host-only, so a `Path=/` expiry could delete the legitimate session.
- A non-HttpOnly cookie cannot shadow the HttpOnly one at `/` on the same host anyway.
- A `Domain`-form planted cookie at `/` on a hostname deployment is visible to script and is expired by the client clearing.

The current request is still answered as anonymous, and the next request is clean. Login normally carries A's leftover session and the planted cookie together, so the login response itself heals. If no root session cookie is present at login, the first platform API call after login returns 401 and heals, and the page returns to login once. That case is documented.

This rule is generic: the server never needs to know which paths A used.

Cookie bombs (enough large cookies to exceed Node's header limit, giving 431 before the application runs) cannot be healed by the server. They are documented as needing a site-data clear.

### 4. Client clearing in the platform's own pages, not `Clear-Site-Data`

`Clear-Site-Data` applies only in secure contexts, and the delivered deployment allows plain HTTP.

Order:

1. confirm the success status;
2. consume the body;
3. clear, best-effort;
4. navigate exactly once.

Every sub-step catches its own failure. Navigation never depends on clearing: the session change is already committed, and stranding the user would not make B safer.

What is cleared:

- `localStorage.clear()` and `sessionStorage.clear()`.
- IndexedDB, when `indexedDB.databases` exists: `deleteDatabase(name)` for each listed name. Each deletion settles on `success`, `error` or `blocked`.
  - `blocked` means another tab holds a connection, for example A's open workbench. The browser finishes the deletion when that connection closes; navigation does not wait.
- Service Workers, when `navigator.serviceWorker` exists: `getRegistrations()`, then `unregister()` each.
- CacheStorage, when `caches` exists: `keys()`, then `delete()` each.
- Script-visible cookies: for each name in `document.cookie`, write an expired cookie at every ancestor of `location.pathname`, including the path itself and `/`, in every cookie form of decision 3.
  - Script cannot overwrite or expire the HttpOnly `platform_session`, so the new session survives.
  - Non-root shadowing session cookies are the server heal's job (decision 3).

### 5. Back/forward cache and open tabs are residual

A page of A's that is still open in a tab, or restored by Back from the back/forward cache, keeps running A's script with whatever cookie the browser now holds. That script reaches B's instance and platform APIs. The platform cannot reach into that page.

`location.assign` keeps history entries, and a `no-store` on every workbench HTML to disable bfcache would cost every reload. So this is documented: on handover, log out and close the browser, or use one profile per person. It is the stated exception to the invariant.

### 6. Test shape (RED first)

- Extends `withAccountUi` through the new upstream option; no second fixture.
- No `page.route` or `context.route`: Playwright interception bypasses Chromium's HTTP cache and would make RED impossible. Observation stays on `page.on('request')` and `upstreamRequests`.
- The origin is `http://127.0.0.1:<port>`, which Chromium treats as potentially trustworthy, so `navigator.serviceWorker` and `caches` exist there.
- One browser context. The owned upstream serves two phases, which the test switches explicitly.

**Phase A.**

- `/` is HTML (no caching headers) referencing `/assets/app-<8 hex>.js`.
- That script returns `Cache-Control: public, max-age=31536000, immutable` and sets marker `A`.
- When run, A's script also:
  - writes `localStorage`, `sessionStorage`, one IndexedDB database and one CacheStorage cache;
  - sets a script cookie `a_pref=1; Path=/`;
  - plants a non-HttpOnly `platform_session=<64 hex>; Path=/_platform/api`.
- The upstream serves `/sw.js` (JavaScript). A's page first pre-warms it with a plain `fetch('/sw.js')`, then attempts `register('/sw.js', { scope: '/', updateViaCache: 'all' })`.

**Phase B.** Same `/` and script URL; the script sets marker `B`.

**Scenario 1: account switch without logout.**

1. A logs in, loads `/`, and sees marker `A`.
2. A's page attempts `navigator.serviceWorker.register('/sw.js', { scope: '/' })`.
3. Without logging out, the page goes to `/_platform/login`; the upstream switches to phase B; B logs in.

Expected:

- the Service Worker registration was rejected, and the only `/sw.js` request that reached the upstream was the plain pre-warm fetch;
- B's page shows marker `B`, and phase B received a script request;
- storage and session storage are empty;
- `indexedDB.databases()` and `caches.keys()` are empty;
- `document.cookie` has no `a_pref`;
- `fetch('/_platform/api/session')` returns 200 with B's email on the first call.

RED before the fix:

- the registration succeeds;
- marker `A`, with no phase-B script request;
- A's storage, database, cache and cookie are present;
- the session read returns 401.

**Scenario 2: logout.** A logs in and loads `/`. The script writes storage, IndexedDB, CacheStorage and `a_pref`, but plants no session cookie: a planted cookie on `/_platform/api` would make logout itself 401 before healing. A opens `/_platform/account` and logs out. On the login page, all of it is gone.

**Unit-only branches.**

- `deleteDatabase` `blocked`;
- throwing steps;
- missing APIs;
- `Domain` cookie forms.

**Integration-only branches.**

- the heal-rule path and cookie-form sets (IP vs DNS host, HTTP vs HTTPS);
- the heal on rejected WebSocket upgrades;
- 403 on `Service-Worker: script`;
- the `Vary` merge matrix.

**Docker spot check.** The real-DSH check proves the header reaches the browser-facing response on real DSH responses. It does not prove browser behaviour; Playwright does.

## Governing invariant

Nothing one platform session leaves in a browser profile is served to, or read by, the platform pages or the workbench of a later session in that profile:

- the HTTP cache, always;
- Service Workers: none can be registered through the gateway;
- storage, IndexedDB, CacheStorage and script-visible cookies at the account pages' paths: once the later user logs in, or the earlier user logs out;
- shadowing session cookies at any non-root path: healed on the first request that carries them.

The only exceptions are code still running in a page of the earlier session (an open tab, or a back/forward-cache restore) and entries cached before this change.

## Sibling surfaces

- **Forwarded HTTP responses** all pass through the single `forwardHttp` callback in `platform/src/gateway/http.ts`. WebSockets go through `forwardWebSocket` and carry no cacheable body.
- **Session-changing pages** are only `account-page.tsx` (login, registration) and `password-page.tsx` (logout). Administrator reset and disable change another user's session on the server with no navigation in that user's browser; their next login clears.
- **WebSocket upgrades** (`app.server.on('upgrade')`, `rejectUpgrade`) bypass Fastify hooks. They get the same heal on duplicate-cookie rejection (decision 3).
- **Session readers** (`request-guard.ts`, `current-session.ts`, `admin/routes.ts`, `password-change.ts`, `model-connection.ts`, gateway admission) keep calling `readSessionCookie` unchanged; the heal hook adds headers only.
- **Asset-transfer check consumers**: `deployment.docker.test.ts`, run by both `pnpm test:deploy` and the full `pnpm test:docker`.
- **UI fixture consumers**: every `*.ui.test.ts` uses `withAccountUi`; the new option is opt-in.

## Must preserve

- Login, registration and logout navigate exactly once, only after the matching success status, with the body consumed first. Failures stay on the form with the existing Chinese messages. Pending fences are unchanged.
- Password change keeps the session and does not clear.
- #370: `Cache-Control: private, max-age=31536000, immutable` is added under the same conditions; DSH's own cache headers and gzip encoding are preserved.
- `Set-Cookie` and trailer stripping, Cookie/Host injection, WebSocket forwarding, the gateway's own redirects and 503s, and `readSessionCookie`'s fail-closed duplicate rule are unchanged. No `Path=/` expiry is ever sent.
- Existing UI tests use the fixture's default upstream unchanged, and the observer gains no new request-failure allowlist entries.

## Non-goals

- Plugin-install lockdown (#375).
- DSH source changes.
- Changes to the session or gateway authorisation model.
- `Clear-Site-Data`.
- Disabling the back/forward cache.
- Protection against a page of A's that is still running.
- Healing cookie bombs.
