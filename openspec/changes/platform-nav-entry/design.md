## Change surface

- `platform/web/src/account-page.tsx`: the landing logic is reduced to `/`. The #358 `administratorLanding` is removed.
  - `isCompleteModelConfig` is removed along with its tests (`platform/web/src/model-config.test.ts:4,77`). Its only consumer was `account-page.tsx:70`.
  - `MODEL_CONFIG_API` stays, because `model-page.tsx:30-33` uses it.
- `platform/web/src/wait-page.tsx`: the administrator-only link in the `unconfigured` state.
- **New route `GET /_platform/api/session`.** It lives in the auth or account module, next to the existing login/logout/change-password routes, with a sibling test. The schema is `{ email: string, role: 'admin' | 'employee' }` for 200, plus 401, then `pnpm contract:write`.
- **New `plugins/platform-nav/`:**
  - `package.json`, with a `dsh.client` platform `web`, an `exports["./client"]` entry, an `inject` of `@deepseek-ai/dsh-client-ui-sidebar`, and the DSH peer pin matching `permission-tiers`;
  - a host `index.js` that reads its row config and, on `webserver/index-inject`, pushes exactly one row `{ kind: 'global', name: '__DSH_TEAM_PLATFORM_NAV__', value: { admin: config?.admin === true } }`. The mechanism is `dsh-host-webserver/lib/index.js:24-27,74-90,345-353`; the precedents are `dsh-client-ui-settings-models/lib/index.js:16-25` and `dsh-client-shortcuts/lib/index.js:13-20`;
  - `client.js` and `client.test.js`;
  - types and a README, mirroring `permission-tiers` and `zh-locale`.
- **`images/dsh-user/Dockerfile`** (critical path): `COPY --from=platform-nav` delivers the plugin root-owned and read-only (`0444` files, `0555` directory) to `/opt/dsh-team/platform-nav/`, with the same peer-pin check as `permission-tiers`.
- **`platform/src/managed-config/generate.ts`**:
  - `ManagedConfigInput` gains a required `admin: boolean`;
  - one `insert` row `{ id: 'platform-nav', name: '/opt/dsh-team/platform-nav/index.js', disabled: false, config: { admin } }`.
- **The instance start path** (`platform/src/orchestrator/start.ts`, critical path) passes `admin: user.role === 'admin'` from the account row it already reads before `generateManagedConfig` (`:515`). That row is fenced by `assertCurrentSnapshot` (`start-identity.ts:80-91`), so a mid-start role change aborts the start. No new query is needed. The diff should be minimal and is flagged for human line review. A `start.test.ts` case asserts that the written overlay has `config.admin` true for an admin row and false for an employee row.
- **Fail loud on a missing flag.** `generateManagedConfig` throws on a non-boolean `admin` at runtime. Every caller passes it explicitly, including the untyped `platform/test/permission-browser-fixture.mjs:394` and the other test callers (`managed-policy-fixture.ts:363`, `model-refusal-fixture.ts:117`, `office-delegation.docker.test.ts:46,161`, `permission-tiers.docker.test.ts:78`, `write.test.ts:55`).
- **Every user-image build invocation gains `--build-context platform-nav=<repo>/plugins/platform-nav`.** These are `platform/test/user-image-fixture.ts`, `scripts/probe-{dsh-api,first-run,sandbox}.sh`, `docs/DEPLOY.md`, `images/seccomp/README.md`, the three plugin READMEs and AGENTS.md. Find them with `git grep "permission-tiers="`. The local build helper (the orchestrator's `build-images.sh`) is not in the repo.
- **`MANAGED_BOOT_ROSTER`** (`platform/test/managed-policy-fixture.ts`) gains `@dsh-team/platform-nav`, plus whatever other exact-roster assertions exist.
- **Tests:** UI, unit and Docker.
- **Docs:** AGENTS.md (landing paragraph, plugin and build-context list) and DEPLOY.md.

## Must preserve

- **Login and registration forms.** These behaviours stay exactly as they are:
  - pending and error handling, and the Chinese messages;
  - the body is consumed before navigating, and navigation happens exactly once, after 200 or 201;
  - credentials never go into a URL or storage.
- **Non-admin landing.** Employee and registration landing stay `/`. Only the administrator branch changes.
- **Admin authority is enforced on the server.** Every `/_platform/admin*` page and API keeps its existing 401/403 handling; the DSH link is navigation only.
- **Waiting page.** Every existing state, its text, start and poll behaviour, retry, single live region, and the employee-visible output stay as they are. The admin link is a plain link, not a live region and not a button.
- **Managed overlay.** All existing rows and their order semantics stay, including the security policy row last before the inserts, the permission plugin insert and the agent-loop injection. Employees still cannot override managed settings.
- **User image.** The pinned DSH version, the seed/profile equality and permission tests, the offline DOCX test, and the existing plugin artifacts stay unchanged. The new files are root-owned, read-only and outside `/data/home`.
- **Real DSH browser lanes.** Chinese UI, no announcement, a usable composer and zero console errors, now with the new plugin loaded.
- **Pairing and gates.** `lint:tests` pairing (`client.js` ↔ `client.test.js` and `index.js` ↔ `index.test.js`), coverage, knip and jscpd. Register the plugin at each per-plugin site:
  - the `plugins/<name>/*.js` coverage include in `vitest.config.ts:46-51`;
  - `knip.json` `entry`/`project` (`:7-19`);
  - the `typecheck` script in `package.json:31`;
  - a `plugins/platform-nav/tsconfig.json`.

## Must add/change

- **Session endpoint.** `GET /_platform/api/session` follows the `gateway/instance-routes.ts:54-70,79-81` pattern:
  - admit in `onRequest` with `identity(request, true)`, which renews;
  - recheck in the handler with `identity(request, false)`;
  - on a storage error, send a sanitized 500 with fixed logging.

  A missing, expired, logged-out or disabled session gives a sanitized 401. The 200 response carries no token, id or timestamps. Only the waiting page consumes it.

- **Plugin client behaviour:**
  - It registers exactly one list entry, `{ name: 'sidebar.footer.action', id: 'dsh-team-platform-nav' }`, and injects into no other slot.
  - It makes **no network request**.
  - It reads `globalThis.__DSH_TEAM_PLATFORM_NAV__` synchronously. It renders 「管理后台」 only when that is an object with `admin === true`; a missing, non-object or non-boolean value means not admin.
  - It always renders 「账号设置」.
  - The plugin makes no console calls and throws no exceptions.
  - Wide mode shows text links; narrow mode (`wide: false`) shows compact icon links with `aria-label`s 「账号设置」 and 「管理后台」.
  - It uses the DSH colour variables and inline styles, with no external assets.
- **Waiting page.** In the `unconfigured` state the page fetches `GET /_platform/api/session` once. If the role is `admin` it appends `<a href="/_platform/admin/models">去配置模型</a>`. Failures add nothing.
- **Role freshness.** The admin flag is fixed per DSH process (overlays are read once at launch: `dsh-app-boot/lib/index.js:1017-1029,3519-3534`). A promotion or demotion is reflected at that user's next instance start. Until then a demoted user may still see the link, but the admin pages and APIs answer 403.
- **Landing.** After a successful login, navigate to `/`. The administrator's first session therefore goes to the gateway: with an unconfigured model that means the waiting page and its admin link, otherwise DSH.

## Governing invariant

Every signed-in user enters DSH from login and can always reach the platform pages from inside DSH. The admin console link is shown only to current administrators, and authority stays enforced by the platform APIs.

## Sibling surfaces

- **Real DSH sidebar.** The footer slot is `dsh-client-ui-sidebar/lib/client.js:398-408,497-519`. It is shared with the Cordis panel button (`dsh-client-ui-cordis/lib/client.js:1411`), which renders only while Cordis plugin activity exists (`:801` returns null otherwise) and must then stay visible above the entry. The Docker lanes have no Cordis activity, so the real-browser evidence proves the stacking rule through the footer cell's computed `flex-direction: column` and `align-items: center`, and records Cordis as absent. The verification browser's 800×600 window opens DSH with the sidebar collapsed, so the probe observes the initial mode first and then toggles to the other.
- **Plugin loading.** `dsh-client-modules` absolute-path meta resolution (`lib/index.js:700-760`) requires `dsh.client.platform === 'web'` and `exports["./client"]`.
- **`requireClient` seeds.** Only `react`-family seeds are available; use `requireClient('react')` as `permission-tiers` does.
- **Admin page links.** The admin sidebar's 「返回工作台」 link to `/` stays.
- **Direct-DSH verification lanes.** `managed-policy-fixture.ts`, `model-refusal-fixture.ts` and `permission-browser-fixture.mjs` load the plugin. It must cause no request or console output there.

## Seams under test

- **Session route and landing:** through `buildApp` with the real HTTP/SQLite path, in integration and UI tests.
- **Plugin client:** `client.test.js` loads `client.js` with a fake `__ModuleLoader__` and slots context. It renders the registered component with React for admin true, admin false, a missing global and a malformed global, in both wide and narrow modes, and checks that no fetch or console call is made.
- **Plugin host:** `index.test.js` checks exactly one global row with the normalised value for config admin true, false, missing and non-boolean.
- **Overlay:** `generate` unit tests check the platform-nav row and its `config.admin` for both roles, and that every other row is unchanged.
- **Real DSH:** `pnpm test:docker` browser cases through the authenticated gateway. Extend `acceptObservation` in `scripts/probe-mapped-host.mjs`, which today checks only the welcome screen and composer, so it can assert the sidebar footer links, follow a click, and check collapsed (narrow) mode.
  - **Employee:** `platform/test/first-use.docker.test.ts`. 「账号设置」 is present and 「管理后台」 absent; clicking 「账号设置」 navigates to `/_platform/account`.
  - **Administrator:** `platform/test/admin-config-activation.docker.test.ts` (`registerInstanceUser`, then `UPDATE users SET role='admin'` at `:30-31`, then a start of that user's instance). Both links are present, and 「管理后台」 navigates to `/_platform/admin`.
  - **Direct-DSH lanes** keep zero console errors with the plugin loaded.
  - Exact boot-roster equality: `@dsh-team/platform-nav` sorts between `@dsh-team/permission-tiers` and `@dsh-team/zh-locale`.
- **User-image artifact:** a Docker check that `/opt/dsh-team/platform-nav` files exist, are root-owned with modes `0444`/`0555`, and that the peer pin matches.

## Required evidence

- **UI:**
  - after an admin login exactly one navigation to `/`, with no model-config request;
  - employee login unchanged;
  - waiting page `unconfigured` as admin shows 「去配置模型」 with the correct href; as an employee it does not;
  - `GET /_platform/api/session` returns 200 with exactly `{email, role}` for both roles, and 401 anonymous, after logout, and for a disabled account.
- **Unit:** the plugin client cases listed above; the wait-page and account-page unit tests updated in their #358-specific parts. Changes to #358 assertions are allowed only where they encode the reversed landing, and they must be listed in the PR.
- **Docker:** the real DSH sidebar evidence, the exact roster, the image file metadata and peer pin, and the full suite green.
- `pnpm check`, `contract:check`, `test:deploy`.

## Non-goals

- Items in the DSH account menu: it is hard-coded, and replacing it is out of scope.
- Embedding platform pages inside DSH.
- Carrying the role in cookies, or refreshing it without an instance restart.
- Changing the admin authority model.
- Opening links in a new tab.

## Review focus

- The removed landing branch has no leftovers: dead code, the browser predicate, AGENTS.md text.
- The plugin uses the real slot API, and the boot roster is exact.
- Dockerfile delivery is root-owned and read-only, with the peer pin.
- Every build-context site is updated, with none missed.
- The session endpoint discloses nothing beyond `{email, role}` and follows the existing lookup semantics.
