## Risk packs

- **Auth / permissions / secrets — selected.** The link is gated on the exact session body naming `role: 'admin'`; authority stays on the server. Tasks 1.1 and 1.2.
- **Legacy compatibility / examples — selected.** Start/poll/retry/departure behaviour, state texts and the employee view stay unchanged; existing exact request lists gain exactly one session GET per page. Tasks 1.2 and 1.3.
- **Documentation / migration notes — selected.** AGENTS.md waiting-page sentence and DEPLOY.md first-use note. Task 1.4.
- **Not selected:**
  - Public API: no route or schema change; the existing session route is reused.
  - Config, schema/DB, file IO, packaging: untouched.
  - Concurrency: one page-local read with an abort controller; covered by task 1.2's departure case.
  - Resource limits: one bounded GET per page load.
  - Error handling: the read's failure paths are task 1.2 cases.

## Must preserve

- Start POST on entry, serial status GET only while `starting`, `running` → `/`, 401 from the instance requests → `/_platform/login`, one-start-per-retry fence, departure cancels owned work (`platform/web/src/wait-page.tsx:84-153`).
- State messages, the 「重试」 button and the 「账号设置」 link for everyone.
- `isAdministrator` accepts only an exactly two-key `{email: string, role: 'admin'}` body.
- The identity read happens at most once per mounted page, never per retry, and never navigates.
- Unchanged consumers: `GET /_platform/api/session` and `platform/test/current-session.integration.test.ts`. No other browser test renders `/_platform/wait` (grep).
- Downstream text that changes with this behaviour: the AGENTS.md sentence "only the waiting page consumes it, once in the `unconfigured` state", `docs/DEPLOY.md:131` step 1, and the `gateway-routing` waiting-page scenario.

## Existing tests that change (contract reversed, not weakened)

- `platform/web/src/wait-page.test.tsx:483-493` "does not read the current identity in the %s state" is inverted to "exactly one identity read in every state". It is not deleted.
- `platform/test/wait.ui.test.ts:176-187`: the session GET moves from after the third start POST to its page-entry position. The identity read is issued in the same mount effect right after the start POST, so issue order is fixed; if the observed request order is not deterministic, assert the session GET with a separate filter (exactly one GET, status 200) and keep the instance-request list exact.
- `platform/test/wait.ui.test.ts:143` (employee) and `:212` (administrator in `unconfigured`) keep their assertions.

## 1. Waiting page

- [x] 1.1 `platform/web/src/wait-page.tsx`: start the identity read once on mount (not on reaching `unconfigured`); render 「管理后台」 → `/_platform/admin` for an administrator in every state; keep 「去配置模型」 only in `unconfigured`.
- [x] 1.2 `platform/web/src/wait-page.test.tsx` (write first, see it fail): an administrator has 「管理后台」 in starting, full, error, stopped and unconfigured, and 「去配置模型」 only in unconfigured; employee, read rejection, non-200 and a malformed body add no console link; one session GET per page across retries; unmount aborts the read and a late admin body adds nothing.
- [x] 1.3 `platform/test/wait.ui.test.ts`, real Chromium:
  - administrator in `full`: click 「管理后台」 → URL `/_platform/admin` with the real admin page loaded (users GET 200);
  - employee in the same `full` state: no 「管理后台」 and no 「去配置模型」;
  - exactly one session GET per page, per the ordering note above.
- [x] 1.4 Docs: AGENTS.md waiting-page sentence and `docs/DEPLOY.md:131`.

## 2. Verification

- [ ] 2.1 `pnpm check`, `pnpm test:ui`
- [ ] 2.2 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`; CI green.

## Non-goals

- No change to start/poll logic, state texts or admin authority.
- No instances-page deep link for `full`.
