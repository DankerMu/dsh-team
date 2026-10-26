## Why

#361: during manual acceptance, the owner rejected the #360 platform UI as amateurish. They asked for a technical, Apple-style frosted-glass look of design-award quality. They chose a light frosted-glass theme that covers every platform page.

## What Changes

A presentation-only redesign of every page under `/_platform/`: login, registration, waiting, account, and the admin accounts, instances, audit, models and runtime pages.

- **Background and surfaces.** One light visual system built on `:root` design tokens.
  - The background is a light base with slowly drifting soft colour glows. They stay still under `prefers-reduced-motion`.
  - Surfaces are glass (`backdrop-filter` blur/saturate, highlight border, inner top highlight, depth shadow). When `backdrop-filter` is unsupported they fall back to near-opaque surfaces.
  - The font stack is local system fonts only.
  - The primary button uses a blue-to-indigo gradient. Inputs, buttons, links and the focus ring all use the same tokens.
- **Admin console.** A glass sidebar holds the navigation; on narrow screens it becomes a top bar. Content sits on glass panels.
  - Tables are restyled.
  - Instance states are shown as status pills.
  - Dialogs get blurred backdrops.
  - The model page uses a field grid with each model as a card.
- **Pages.** Login and registration keep the brand/form split on a glass card over the background. The waiting and account pages use centred glass cards.
- **Scope limits.** No backend, API, gateway, routing or behaviour change. Accessible names, roles, live regions and Chinese strings stay unchanged. Wrapper elements and classNames may be added.

This change also archives the merged #358 change (`2026-10-25-admin-landing-login-layout`), whose layout requirement it modifies.

## Triage

```text
Issue type: feature
Fixture level: expanded (shared stylesheet and admin navigation component consumed by every platform page)
Upstream suggested level: absent (agree: expanded on the shared-entrypoint trigger)
Blast radius: visual rendering and layout of every platform page; test selectors if DOM changes leak
Selected risk packs: Legacy compatibility / examples; Resource limits / large input / discovery; Documentation / migration notes
Evidence floor: pnpm check; pnpm test:ui with desktop+narrow screenshots of every page, no horizontal overflow, zero console errors; owner approval of screenshots; exact-head VPS test:docker + test:deploy
```
