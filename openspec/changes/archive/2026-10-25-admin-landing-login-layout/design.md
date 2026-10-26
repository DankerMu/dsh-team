## Change surface

- `platform/web/src/account-page.tsx`: `CredentialForm`, login success branch only.
- A new shared browser module `platform/web/src/model-config.ts`, with sibling test `model-config.test.ts`. It holds the model-config body validator and the completeness predicate, extracted from `model-page.tsx` `readConfiguration`. `model-page.tsx` then imports it.
- `platform/web/src/style.css` and the login/registration markup.
- `AGENTS.md`: the platform UI paragraph.

## Must preserve

- Login and registration request semantics, the in-flight fence and the Chinese rejection messages.
- Employee login and registration still land on `/`. These depend on it: `wait.ui.test.ts:44` and `password.ui.test.ts:60,207,217` (employee form logins), and `login.ui.test.ts:158-159` (`admittedUsers`/`upstreamRequests` for the employee).
- Exact strings and roles used by tests:
  - headings `登录 DSH 团队平台` and `注册 DSH 团队平台`;
  - buttons `登录`, `注册`, `正在登录…` and `正在注册…`;
  - links `没有账号？注册`, `已有账号？登录` and `账号设置` (also checked at `account-page.test.tsx:324`);
  - exactly one `status`/`alert` region per form.

  The brand panel must not add a heading or text matching `/注册/` or `/登录/` as a heading, and must not add a second live region.

- Screenshot names: `login`, `login-pending`, `login-unknown-account`, `login-disabled`, `login-limited`, `login-authenticated-local-destination`, plus the existing `registration-*` set.
- The model page's existing validation behaviour: same accepted and rejected bodies, same error messages.

## Must add/change

- After login, an administrator lands on `/_platform/admin/models` when settings are incomplete and on `/_platform/admin` otherwise.
- Two-column layout for login and registration; a shared set of CSS custom properties.

## Governing invariant

A successful login always navigates exactly once, to a fixed same-origin path chosen only from `/`, `/_platform/admin` or `/_platform/admin/models`. A failed auxiliary read never turns that login into a failure or leaves the user on the login page.

## Sibling surfaces

- **Consumers of the model-config validator:** `model-page.tsx` (`readConfiguration`, GET and saved PUT variants) and the new landing read.
- **`style.css` consumers:** `password-page.tsx` (`/_platform/account`), `wait-page.tsx`, the admin pages (`admin-page`, `instance-page`, `audit-page`, `model-page`, `runtime-page`) and `admin-navigation.tsx`.
- **Server:** none. The login response already carries `role`, and the model-config GET is unchanged (`schemas/openapi.json`).

## Seams under test

- The browser `CredentialForm` behaviour (unit tests with stubbed `fetch`, both success and failure paths).
- The real compiled UI over a real backend and SQLite (Playwright `login.ui.test.ts`, `registration.ui.test.ts`).
- The shared validator (`model-config.test.ts`) and the unchanged `model-page.test.tsx`.

## Required evidence

| Input                                                                        | Expected result                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin login, settings absent                                                 | URL `/_platform/admin/models`; `admittedUsers` and `upstreamRequests` both `[]`                                                                                        |
| Admin login after a real admin PUT of complete settings                      | URL `/_platform/admin`; same empty arrays                                                                                                                              |
| Admin landing GET returns 500, network failure or malformed body (unit test) | `/_platform/admin`; no error text shown                                                                                                                                |
| Employee login                                                               | `/` (existing assertions)                                                                                                                                              |
| Registration 201                                                             | `/`                                                                                                                                                                    |
| Login and registration pages at 1280×800 and 390×844                         | Screenshots `login-desktop`, `login-narrow`, `registration-desktop`, `registration-narrow`; `document.documentElement.scrollWidth <= clientWidth`; zero console errors |

## Non-goals

See `tasks.md`.

## Review focus

- No second copy of the model-config validator.
- No landing request other than the single admin GET.
- Bodies are consumed before navigation.
- Test-visible strings and live regions are unchanged.
- No horizontal overflow at the narrow width.
