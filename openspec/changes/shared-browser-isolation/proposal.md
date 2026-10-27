## Why

#372. Every employee instance is served through the platform gateway on one browser origin, `PLATFORM_PUBLIC_URL`. Each employee fully controls what their own instance returns:

- The sandbox is `danger-full-access` in all three tiers (`platform/src/managed-config/generate.ts:48-52`).
- The terminal is kept (F45/D12).
- The profile under `/data/home/profiles/web` is writable by uid1001, and code placed there is loaded (`managed-policy-fixture.ts:168-180`).

So employee A can return any path, body and caching header from their instance, and run script on the platform origin within A's own session. In a shared browser profile, what A leaves behind reaches the next user, B, who may be the administrator:

- **HTTP cache.** The gateway forwards upstream response headers unchanged apart from hop-by-hop headers and `Set-Cookie` (`platform/src/gateway/http.ts`). A response cached under A's session, for example a script marked `immutable`, is served to B at the same URL without reaching B's instance. It then runs on the platform origin with B's session.
- **Origin storage.** `localStorage`, `sessionStorage`, IndexedDB and CacheStorage written by A's script persist, and B's legitimate DSH frontend reads them.
- **Shadowing session cookies.** A can plant a non-HttpOnly `platform_session` at a deeper path such as `/_platform/api`. `readSessionCookie` (`platform/src/auth/session-cookie.ts:28`) treats a duplicate name as no session, so this cannot impersonate. It does lock every later user out of all platform APIs, the instance-start loop included. Script on the account pages cannot see that path.
- **Service Workers.** On an HTTPS deployment (TLS from the external proxy, `docs/DEPLOY.md` §6), and on loopback, A can register a worker served from A's instance with scope `/`. It would control `/_platform/login` and could read B's password.

`Clear-Site-Data` is not used, because browsers apply it only in secure contexts and the delivered deployment allows plain HTTP. Locking plugin installation is not a security boundary here, for the reasons above; it is the separate compliance issue #375.

## What Changes

- **Per-session HTTP cache.** The gateway merges `Cookie` into `Vary` on every forwarded workbench HTTP response:
  - absent → `Cookie`;
  - otherwise append once, matched case-insensitively;
  - `*` is left unchanged.

  The browser's `Cookie` request header always carries the per-user, per-login HttpOnly `platform_session`. A's cache entries therefore never match B's requests.

- **No Service Worker through the gateway.** A request carrying the `Service-Worker` request header, which browsers send on every worker script fetch, is answered 403 and not forwarded. DSH uses no Service Worker.
- **Server heal for shadowing session cookies.** When a request carries more than one `platform_session`, the response appends expiry `Set-Cookie` headers for every non-root ancestor of the request path:
  - with and without a trailing slash;
  - host-only and `Domain` forms.

  Admission is unchanged: the request is still treated as having no session. `Path=/` is never expired.

- **Client clearing on account switch.** After a successful login (200), registration (201) or logout (204), once the body is consumed and before the single navigation, one platform web module clears:
  - `localStorage` and `sessionStorage`;
  - all IndexedDB databases;
  - Service Worker registrations and CacheStorage, when those APIs exist;
  - script-visible cookies at every ancestor of the page path, host-only and `Domain` forms.

  A clearing step that fails or is blocked never prevents or delays navigation.

- **Evidence.**
  - A RED-then-GREEN two-user Playwright Chromium test in the existing account UI fixture, on `http://127.0.0.1` without request interception. A leaves an immutable script, storage, IndexedDB, CacheStorage, a script cookie and a shadowing session cookie, and attempts a Service Worker registration, without logging out. B then logs in in the same context.
  - A logout variant.
  - Gateway and auth integration tests.
  - The real-DSH deployment transfer check asserts that `Vary` contains `Cookie` on the native HTML, the hashed entry script, the combined plugin script and the event stream.
- **Documentation.** `docs/DEPLOY.md` gains:
  - an upgrade step: clear browsing data once in shared profiles, because entries cached before the upgrade carry no `Vary`;
  - the residual risks: A's own session; a page of A's still open or restored from the back/forward cache; a shadowing cookie at login time without a root session, which costs one return to the login page; cookie bombs (431) needing a site-data clear; one profile per person and closing the browser on handover remain the recommendation;
  - the cold load after each login.

  AGENTS.md gateway and platform-UI paragraphs are updated.

- The archive of `submission-call-label` (#373) rides in this branch, because every PR needs exact-head Docker evidence.

## Triage

```text
Issue type: security fix (existing risk, not a regression)
Fixture level: expanded
Upstream suggested level: issue states P1 for shared workstations, P2 otherwise
Blast radius: every forwarded workbench response (cache key), every request with a duplicate session cookie (extra Set-Cookie), every login/registration/logout navigation
Selected risk packs: Auth / permissions / secrets; Public API / protocol / HTTP semantics; Legacy compatibility / migration; Concurrency / multi-tab; Error handling / partial outputs; Performance / caching; Resource limits (documented only); Documentation
Evidence floor: Vary/SW/heal integration tests; clearing-module unit tests; RED-then-GREEN two-user Playwright test (pnpm test:ui); pnpm check; exact-head VPS pnpm test:docker and pnpm test:deploy with the Vary assertion on real DSH
```

## Impact

- **Changed files:**
  - `platform/src/gateway/http.ts`, `platform/src/gateway/routes.ts`;
  - `platform/src/auth/` (new heal hook), wired in `app.ts`;
  - `platform/web/src/` (new clearing module, `account-page.tsx`, `password-page.tsx`);
  - `platform/test/account-ui-fixture.ts` (upstream option), a new `platform/test/shared-browser.ui.test.ts`, and `platform/test/deployment-asset-transfer-fixture.ts`;
  - `docs/DEPLOY.md`, `AGENTS.md`;
  - tests for each.
- **Cost:** #370's long-lived asset cache is kept within one login session only. After a new login the workbench assets are downloaded again: about 9.5 s cold over the acceptance SSH tunnel, much less on a direct intranet link.
- **Not affected:** no critical path, no DSH change, no dependency, no workflow change, no new configuration. The OpenAPI contract is unaffected: no route or schema changes. The new 403 is gateway behaviour for non-`/_platform` paths.
