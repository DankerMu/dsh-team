## Change surface

- `platform/web/src/style.css`, which is rewritten as the design-token system.
- `admin-navigation.tsx`, which gains a sidebar shell.
- Wrapper elements and classNames added in `account-page.tsx`, `password-page.tsx`, `wait-page.tsx`, `admin-page.tsx`, `instance-page.tsx`, `audit-page.tsx`, `model-page.tsx` and `runtime-page.tsx`.
- Screenshot additions in the existing UI tests.
- The `AGENTS.md` platform-UI sentence about layout.

## Must preserve

- **Behaviour.** All of it, on every page: requests, fences, confirmations, polling, navigation, error handling and authority handling.
- **Test-visible contracts.**
  - Accessible names and roles (headings, forms, buttons, links, `nav[aria-label="后台导航"]`, `aria-current="page"`).
  - Exactly one live region per form.
  - Every exact Chinese string.
- **Structural hooks the tests query.** These come from a survey of `platform/test/*.ui.test.ts` and `platform/web/src/*.test.tsx`:
  - `table`, `tbody tr`, `td:nth-child(5)` (the audit column, `admin-audit.ui.test.ts:157-370`), `dialog` / `[role="dialog"]`, `details`, `pre`, `time`, `form`, `#email`, `.admin-pages`, `.auth-brand` (`account-page.test.tsx:511`, `account-ui-fixture.ts:217`), `data-audit-id` (`admin-audit.ui.test.ts:59`), `getByLabel('审计分页')` (`admin-audit-states.ui.test.ts:52`), the nav `a[href=…]` selectors (`admin-navigation.test.tsx`) and `h1`;
  - the `fieldset, legend` absence check on login and registration.

  Column order and the table semantics must stay the same.

- **Instance status cell's accessible name.** `admin-instances.ui.test.ts:53` asserts it with `getByRole('cell', { name, exact: true })`, so it must stay exactly the status text. Pills must not add an aria-label, a role, or text inside a dot indicator.
- **No new interactive or live elements.** Pills, the wait indicator and the admin shell must not add any of the following:
  - `role=status`, `role=alert` or `aria-live`. Tests make single strict `getByRole('status'|'alert')` queries (`wait.ui.test.ts:112`, `admin-instances.ui.test.ts:68`) and require a live-region count of 1 (`account-ui-fixture.ts:235`, `account-page.test.tsx:508`).
  - buttons. Denied states assert a button count of 0 (`admin-account-states.ui.test.ts:49`, `admin-instance-states.ui.test.ts:45,126`, `admin-audit-states.ui.test.ts:129`). So the narrow navigation has no toggle button.
  - forms. Form count is asserted as 0 (`admin-audit-states.ui.test.ts:128,164`, `admin-models.ui.test.ts:145`).
  - table rows. Row counts 21, 4 and 2 are asserted (`admin-account-states.ui.test.ts:218-230`).
  - headings, in the sidebar or the brand panel. The auth pages allow one heading (`account-ui-fixture.ts:234`, `account-page.test.tsx:507`).
- **Login/registration geometry** (`account-ui-fixture.ts:220-221`). On desktop the brand panel's right edge is ≤ the form's left edge. On narrow screens the brand panel's bottom is ≤ the form's top.
- **Brand panel.** No heading, no second live region, and no text matching `/登录/` or `/注册/`.
- **Existing screenshot names.**
- **No external resources.** No `url(http…)`, `@import` or `@font-face`, and no images except inline CSS gradients. The existing favicon stays.

## Must add/change

- The visual system in the proposal, applied to every page.
- Admin pages are wrapped in a shell: a sidebar holding `AdminNavigation` plus a main content panel. The sidebar becomes a top bar below the narrow breakpoint.
- Instance status cells render as pills. The text stays the same, and the cell's accessible name stays exactly the status text (`getByRole('cell', { name, exact: true })`, `admin-instances.ui.test.ts:53`).

## Governing invariant

The redesign changes only how pages look. Every DOM query, accessible name and request sequence that the existing unit and UI tests assert keeps its result.

## Sibling surfaces

- **Every page component listed under change surface.** Plus `main.tsx`, which mounts the pages, and `favicon.svg`, which is unchanged.
- **The DSH UI.** Out of scope.
- **Server static serving.** Unchanged; only the bundled CSS and JS change.

## Seams under test

- The real compiled UI over a real backend and SQLite (`pnpm test:ui`).
- Unit DOM tests (`pnpm test`).

## Required evidence

- Every existing unit and UI test passes unmodified, except for added screenshot or layout assertions.
- The existing `login-desktop`, `login-narrow`, `registration-desktop` and `registration-narrow` screenshots and their overflow check (`expectLayoutViewports`, `account-ui-fixture.ts:205-238`) are kept under the same names, not duplicated. That viewport and overflow logic is extracted into one shared helper, which the other pages reuse (no copies; jscpd).
- The waiting-page screenshots run against the substituted start/status APIs, as the existing wait suite does. Real Docker startup is not claimed.
- A screenshot per page at 1280×800 and 390×844. At the narrow size, assert `document.documentElement.scrollWidth <= clientWidth`. The screenshot names are listed in `tasks.md`.
- Zero console, page or request errors, and zero external requests (the existing `expectHealthy`).
- The owner approves the screenshots before the PR.

## Non-goals

- Dark mode.
- Icons, illustrations or web fonts.
- Animation beyond the background drift and hover/press transitions.
- Restructuring forms or tables beyond wrappers.
- Any change to the DSH UI.

## Review focus

- No test-visible contract changed.
- No external resource.
- WCAG AA text contrast on glass over the background.
- A `backdrop-filter` fallback.
- Reduced-motion handling.
- No horizontal overflow at 390px.
