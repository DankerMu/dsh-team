## Why

#367. After #365 an administrator also enters through `/`, and while their own instance is not running the gateway sends them to `/_platform/wait`. The waiting page links an administrator to the console only in the `unconfigured` state (「去配置模型」, `platform/web/src/wait-page.tsx:115,166`). In `full`, `error`, `stopped` or a long `starting` it offers only 「重试」 and 「账号设置」. The worst case is `full`: the running limit is reached, and the administrator who could free a slot has no link to the console.

## What Changes

- The waiting page reads `GET /_platform/api/session` once per page on entry, independent of start attempts and retries, and aborts it on departure. It no longer waits for the `unconfigured` state.
- An administrator sees the plain link 「管理后台」 → `/_platform/admin` in every waiting state. In `unconfigured` the existing 「去配置模型」 → `/_platform/admin/models` stays as well.
- Employees see exactly what they saw before. A failed read, a non-200 status or a body that is not exactly `{email, role}` adds nothing. The identity read never navigates; 401 handling stays with the instance requests.
- Spec `gateway-routing` (the waiting-page scenario) and the AGENTS.md waiting-page sentence are updated.
- `design.md` is omitted (compact fixture).

This change also carries the archive of `platform-nav-entry` (#365, merged in #366) in its own commit, because every PR needs exact-head VPS Docker evidence and one run covers both.

## Triage

```text
Issue type: feature
Fixture level: compact
Upstream suggested level: absent (override: Auth and Legacy packs are selected, but no authorization decision, API, schema or stored state changes; the link is navigation only and the server keeps enforcing the role)
Blast radius: the waiting page's link row; a wrong guard shows a console link to an employee (navigation only, server still enforces the role) or hides it from an administrator
Selected risk packs: Auth / permissions / secrets; Legacy compatibility / examples; Documentation / migration notes
Evidence floor: wait-page.test.tsx, pnpm test:ui (wait.ui.test.ts), pnpm check; exact-head VPS pnpm test:docker + pnpm test:deploy for the CI evidence gate
```
