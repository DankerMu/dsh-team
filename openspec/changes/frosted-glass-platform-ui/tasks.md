## Risk packs

- **Legacy compatibility / examples — selected.** Every existing test asserts DOM and strings, and the redesign must keep them green without editing their assertions. Tasks 1.x and 3.1–3.2.
- **Resource limits / large input / discovery — selected.** Large admin tables and long values (emails, error logs, `pre` output) must not overflow at narrow widths. Task 2.3 and the narrow screenshots in task 2.4.
- **Documentation / migration notes — selected.** The AGENTS.md platform-UI layout sentence changes. Task 2.5.
- **Not selected:**
  - Auth, Concurrency, Error handling: behaviour is unchanged.
  - Public API, Config, File IO, Schema: no such surface.
- **Release / packaging / dependency compatibility — selected.** The platform image ships the web build. Task 3.5.

## Must preserve

See `design.md`, "Must preserve".

## 1. Visual system

- [x] 1.1 Rewrite `style.css` around `:root` tokens:
  - background: base colour plus 3–4 radial-gradient colour glows on a fixed pseudo-element, slowly drifting, static under `prefers-reduced-motion`;
  - glass surfaces: `backdrop-filter: blur() saturate()`, highlight border, inner top highlight, layered shadow;
  - an `@supports not (backdrop-filter…)` near-opaque fallback;
  - a system font stack (Apple system, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui);
  - type scale, radius scale, focus ring, primary gradient button with glow, secondary glass button, danger button, glass inputs/selects with a focus glow, links, alert/status styles.
- [x] 1.2 Text contrast: body and label text ≥ 4.5:1 against the effective glass background, large headings ≥ 3:1.

## 2. Pages

- [x] 2.1 **Login and registration.** Keep the brand/form split. The brand side is typographic: product name in large gradient text plus one factual line, no heading role. The form sits on a glass card over the background.
- [x] 2.2 **Waiting and account pages.** Centred glass cards. The waiting page shows its existing state text, with a subtle CSS-only indicator while starting.
- [x] 2.3 **Admin pages.**
  - Shell: a sidebar holding `AdminNavigation` plus a main glass panel. Below the narrow breakpoint it becomes a top horizontal bar that scrolls inside itself rather than the page.
  - Tables: light header, row hover, horizontal scroll contained in the panel for wide tables, long text wrapping.
  - Instance status pills (same text).
  - Dialogs: glass with a blurred `::backdrop`.
  - Model page: field grid and model cards.
  - Runtime page: field grid.
- [x] 2.4 **Screenshots.** Add desktop (1280×800) and narrow (390×844) screenshots, asserting `scrollWidth <= clientWidth` at narrow width, named:
  - the existing `login-desktop`, `login-narrow`, `registration-desktop` and `registration-narrow`, kept as they are;
  - `glass-wait-desktop`, `glass-wait-narrow`, `glass-account-desktop`, `glass-account-narrow`;
  - `glass-admin-accounts-desktop`, `glass-admin-accounts-narrow`, `glass-admin-instances-desktop`, `glass-admin-instances-narrow`;
  - `glass-admin-audit-desktop`, `glass-admin-audit-narrow`, `glass-admin-models-desktop`, `glass-admin-models-narrow`;
  - `glass-admin-runtime-desktop`, `glass-admin-runtime-narrow`.

  Place them in the existing UI test that already renders each page with real data, so tables and forms are populated. The waiting page is the exception: it uses the existing substituted start/status APIs. Generalise `expectLayoutViewports` (`account-ui-fixture.ts`) into one shared viewport-plus-overflow helper that every page reuses.

- [x] 2.5 Update the AGENTS.md platform-UI sentence describing the layout (glass system, admin sidebar shell). Flag the rule-file change in the PR.

## 3. Verification

- [x] 3.1 `pnpm check`
- [x] 3.2 `pnpm test:ui`, with existing assertions unmodified.
- [x] 3.3 `pnpm test:integration`
- [x] 3.4 The owner approves the screenshots.
- [ ] 3.5 Exact-head VPS `pnpm test:docker` + `pnpm test:deploy`; CI green.

## Implementation deviations (owner-approved)

- Dialogs are inline `<dialog open role="dialog">`, not `showModal()`, so `::backdrop` never applies. The dim layer is `.admin:has(dialog[open])::after`, with `pointer-events: none`.
- Tables do not wrap long text. Email cells stay on one line, and the table scrolls inside `.admin-table`. Error `pre` text wraps (`overflow-wrap: anywhere`).
- The waiting page shows a slowly rotating ring while `aria-busy`. It stays still under reduced motion.
- The content-panel glass is painted on `.admin-content::before`. Account and instance status are pills with unchanged text.
- The sidebar shows a non-heading wordmark `<p class="admin-wordmark">` and is not sticky.
- On admin pages the `<h1>` now follows `AdminNavigation` inside `.admin-content`, so the nav links come first in reading and Tab order.
- `account-page.tsx` needed no change.
- Text contrast (task 1.2) was checked by review only, against the approved screenshots. No automated contrast check exists.

## Non-goals

See `design.md`, "Non-goals".
