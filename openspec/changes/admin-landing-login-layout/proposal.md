## Why

#358: during manual stage-1 acceptance, the administrator logged in and was sent to `/` (`platform/web/src/account-page.tsx:87`). The gateway then started the administrator's own DSH instance. Models were not configured yet, so it landed on the waiting page reading “管理员尚未完成模型配置”. That is a dead end with no route to the configuration screen. The login and registration pages also use native grey buttons and a redundant fieldset/legend. They read as unfinished.

## What Changes

- **Role-based landing after login.** The login API already returns `role`.
  - A parseable body with string `role === 'admin'` takes the admin path; any other outcome (employee, unparseable body, missing/unknown role) navigates to `/`, as before.
  - `admin` reads the existing `GET /_platform/api/admin/model-config` once:
    - If the response is a valid 200 and the settings are incomplete, navigate to `/_platform/admin/models`.
    - For every other outcome (complete settings, non-200, transport/parse failure, malformed body), navigate to `/_platform/admin`.
  - The model-config body validator and the completeness predicate are extracted from `model-page.tsx` `readConfiguration` into one shared browser module used by both pages (no second copy). "Incomplete" uses the same fields as the server predicate `hasCompleteModelSettings` (`platform/src/managed-config/generate.ts:111-123`): blank `baseURL`, `apiKeyConfigured` false, empty `models`, or blank `defaultModel`.
  - Registration (always an employee) still navigates to `/`.
- **Two-column login and registration.**
  - A brand panel (product name plus one factual line) and the form panel side by side; on narrow viewports the brand panel collapses above the form.
  - The fieldset border and the redundant legend are removed, while each form keeps its accessible name.
  - One set of CSS custom properties (colours, radius, focus ring, primary button, error text) is used by the login/register, account, waiting and admin pages. Admin page structure is unchanged.
  - The login page keeps its secondary links to registration and account settings.

## Triage

```text
Issue type: feature
Fixture level: expanded (shared entrypoint: every user's first navigation after login; auth-adjacent role routing; shared stylesheet consumed by every platform page)
Upstream suggested level: absent (agree: no upstream level; expanded chosen on the triggers above)
Blast radius: every user's first navigation after login; visual regression on all platform pages
Selected risk packs: Auth / permissions / secrets; Error handling / rollback / partial outputs; Documentation / migration notes
Evidence floor: pnpm check; pnpm test:ui (real backend login landing for admin incomplete/complete, employee, registration; screenshots desktop+narrow); pnpm test:integration; exact-head VPS test:docker + test:deploy
```
