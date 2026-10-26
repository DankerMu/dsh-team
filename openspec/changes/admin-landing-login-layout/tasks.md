## Risk packs

- **Auth / permissions / secrets — selected.** The landing read happens with the administrator session just issued and uses only the existing admin-only GET. No key or password enters the URL, storage or diagnostics. Tasks 1.1 and 1.4.
- **Error handling / rollback / partial outputs — selected.** A failure of the landing read must not turn a successful login into an error, and must not leave the user on the login page. Tasks 1.1, 1.2 (500/network/malformed paths) and 1.3.
- **Documentation / migration notes — selected.** The AGENTS.md sentence "navigates to `/` only after the matching success status" changes. Task 2.4.
- **Not selected:**
  - Concurrency: the existing in-flight fence is unchanged.
  - Public API, Config, File IO, Schema, Resource limits, Legacy, Release: no such surface.

## Must preserve

The exact test-visible strings, screenshot names and dependent tests are listed in `design.md` (Must preserve).

- The login and registration request bodies, `credentials: 'same-origin'`, `redirect: 'error'`, the in-flight fence, the pending text and every Chinese rejection message (`account-page.tsx`).
- Registration navigates to `/` after 201. Employee login navigates to `/` after 200.
- Accessible names used by existing UI tests: forms labelled 登录/注册, inputs labelled 邮箱/密码, the status/alert region, and the links to register and to account settings. Update a selector only if markup must change, and say so in the deviation report.
- Waiting page behaviour, admin page DOM structure, `AdminNavigation` links.
- The `/_platform/*` static route set and the 404 semantics. No new page route.

## 1. Landing

- [x] 1.1 In `CredentialForm`, on login 200, parse the JSON body.
  - A parseable body with string `role === 'admin'`: issue one `GET /_platform/api/admin/model-config` (same-origin, `redirect: 'error'`). Navigate to `/_platform/admin/models` only when it is a 200 whose body is an object with the expected field types and the settings are incomplete. Every other outcome of that GET navigates to `/_platform/admin`.
  - Any other login outcome (employee role, unparseable body, missing or unknown role): navigate to `/`.
  - Extract the model-config body validator and completeness predicate from `model-page.tsx` `readConfiguration` into `platform/web/src/model-config.ts`, with a sibling `model-config.test.ts`. Both pages use it, with no duplicated validation. Model-page behaviour is unchanged.
  - Consume every response body before navigating (AGENTS.md note 9).
  - Keep the pending state until navigation is issued.
- [x] 1.2 Unit tests in `account-page.test.tsx`: admin incomplete → models page; admin complete → console; admin GET 500/network error/malformed → console; employee → `/`; unparseable login body → `/`; registration 201 → `/`. Show RED against the pre-change source.
- [x] 1.3 Playwright (`platform/test/login.ui.test.ts`, real backend and SQLite):
  - an administrator created through the existing seeding path lands on `/_platform/admin/models` while settings are absent;
  - after model settings are saved through the real admin API, a fresh login lands on `/_platform/admin`;
  - an employee lands on `/`, and the existing registration case still lands on `/`.
  - For both admin cases, `admittedUsers` and `upstreamRequests` stay `[]`. No instance is started.
  - Zero unexpected console or request failures.
- [x] 1.4 Assert that no landing navigation URL carries credentials, and that no request beyond login + model-config (admin) or login (employee) is issued before navigation.

## 2. Layout

- [x] 2.1 Restructure the login and registration markup into a brand panel plus a form panel. Remove the fieldset border and legend, keeping the accessible names in Must preserve. Brand panel copy: the product name “DSH 团队平台” plus one factual line, no invented claims.
- [x] 2.2 Rewrite `style.css` around `:root` custom properties: colours, radius, focus ring, primary button, error/alert text, card. Apply them to account, waiting and admin pages without changing their structure. Use a narrow breakpoint for the stacked layout, with no horizontal scroll at 390px width.
- [x] 2.3 Playwright screenshots `login-desktop`, `login-narrow`, `registration-desktop` and `registration-narrow` at 1280×800 and 390×844, retained under `reports/platform-ui/`. Assert `document.documentElement.scrollWidth <= document.documentElement.clientWidth`, and zero console errors. Existing screenshot-producing tests keep working.
- [x] 2.4 Update the AGENTS.md platform UI paragraph ("navigates to `/` only after the matching success status") to describe role-based landing. Flag the rule-file change in the PR.

## 3. Verification

- [ ] 3.1 `pnpm check`
- [ ] 3.2 `pnpm test:ui`
- [ ] 3.3 `pnpm test:integration`
- [ ] 3.4 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`; CI green.

## Non-goals

- Server, API, OpenAPI contract, gateway or waiting-page state changes.
- Remembering the last visited admin page, deep-link return-after-login, or an admin "workbench" chooser.
- Dark mode, icons, web fonts or external assets (static assets stay local).
