## Risk packs

- **Error handling — selected.** The promised behaviour is a failure path: a bounded wait ending in a visible plugin failure text, never blank or endless loading. Tasks 1.1, 1.4; evidence 2.2.
- **Documentation — selected.** Employee guide failure section, operator notes in `docs/DEPLOY.md` and D11, stack-lane descriptions in `docs/LOCAL_STACK.md` and `platform/test/README.md`. Tasks 1.2, 1.3, 1.4.
- **Concurrency / shared state / ordering — selected.** The scenario changes the deployment-wide Office configuration and restarts the employee instance inside the shared stack lane; it must run after the existing Office scenarios and restore bundled mode in `finally` even when its assertions fail, so later lanes, the evidence line and the inventory fence are unaffected. Task 1.4; evidence 2.2.
- **Not selected:** public API/CLI (no route change; the scenario uses the existing admin route), schema/HTTP contract, auth/secrets (the scenario's JWT is a random test value, never logged or written to evidence), config/project setup (no `.env.example` or compose change), legacy compatibility (no product behaviour changes), release/packaging (nothing in `images/` or `plugins/`), file IO/path safety, resource limits.

## Acceptance-criteria mapping

- AC1 (spec scenario; `openspec validate --specs --strict` passes) → task 1.1; evidence 2.1.
- AC2 (employee guide texts match `dsh-sidebar-onlyoffice@0.2.0` `src/client/locales.ts`) → task 1.2.
- AC3 (DEPLOY.md external bullet and D11: licence and connection limit are the operator's) → task 1.3.
- AC4 (stack scenario asserts a failure text with an unreachable address and restores bundled mode in `finally`; exact-head `pnpm test:stack` evidence) → task 1.4; evidence 2.2.
- AC5 (`pnpm fmt:check`; PR `## Runtime evidence`) → evidence 2.1, 2.3.

## Must preserve

- The bundled path and every existing stack scenario's assertions, deadlines and order; the new scenario runs after `officeIdleScenario`.
- Bundled mode is restored (admin `PUT {mode:'bundled'}`, then instance restart) on every exit path of the scenario, and the restore itself is asserted (config reads back bundled; the restarted instance reaches the bundled Document Server).
- The random JWT never appears in logs, evidence, screenshots or failure messages.
- No change under `platform/src/`, `plugins/`, `images/`; the "Office 不可用时的退路" requirement text is unchanged.
- The lane's zero-console-error and external-request rules stay global: the scenario's one expected failure (the proxied `api.js` 502) is accepted only by the exact console/response/requestfailed triple in task 1.4, recorded in the evidence, never by widening an existing allowlist.
- No lengthened per-step wait; the failure wait is bounded by the plugin's own timeout plus a stated margin. The stack `testTimeout` cap grows only by this lane's derived upper bound, recorded in `vitest.config.ts` per that file's convention.

## 1. Implementation

- [x] 1.1 Spec delta as written (`specs/office-editing/spec.md`); the bounded wait is described, not given a number in the spec. Runtime evidence covers only the refused-port DOCX case; the timeout, non-DS-200, XLSX and PPTX cases rest on reading the 0.2.0 source, and the PR says so.
- [x] 1.2 `docs/EMPLOYEE_GUIDE.md`: new "打开失败" section after the existing hint sections, quoting the panel heading 「打开失败」 and the failure texts 「无法加载 ONLYOFFICE 编辑器脚本」「无法获取编辑器配置」「ONLYOFFICE 编辑器初始化失败」「ONLYOFFICE 编辑器发生错误」 verbatim from `dsh-sidebar-onlyoffice@0.2.0` `src/client/locales.ts`, their meaning, and what to do: the panel's 「下载文件」 link works meanwhile and the file is unchanged; tell the administrator, who corrects the Office settings and restarts the employee's instance (or it applies at the next start); then reload the page and reopen the file. Update the section intro if it enumerates the hints. Say that a failure that persists is not the startup window covered by the restart note (#672), so the employee should not just keep waiting.
- [x] 1.3 `docs/DEPLOY.md` external Document Server bullet and `docs/REQUIREMENTS_BASELINE.md` D11: the platform does not probe the external address; a wrong address shows employees the plugin's open-failure panel; after correcting it, restart affected instances; a licensed external Document Server's connection limit and full-capacity message are handled by that Document Server and its capacity is the operator's responsibility; the project adds no hint. Wrong-JWT behaviour of a reachable Document Server is described as unverified, not described.
- [x] 1.4 Stack scenario in a new `platform/test/` fixture file (with a `<fixture>.integration.test.ts` sibling for its pure helpers), wired in `platform/test/platform-stack.stack.test.ts` after `officeIdleScenario` and before the `docserviceSpawns` check (respect the 800-line limit after the #672 rebase; move helpers into the fixture rather than growing the test file past it). It begins from the idle-stopped employee instance left by `officeIdleScenario`.
  - Precondition: GET `/_platform/api/admin/document-server` reads `mode: 'bundled'` with `bundledConfigured: true` (so restoring bundled restores the original state); reuse the office-profile lane's `REWRITTEN_URL` (`http://127.0.0.1:9`) and its no-listener check inside the instance (`platform/test/office-profile-stack-fixture.ts:22-23, :51-57`; the check is inline in `registerScript`, so first extract it into a shared exported helper used by both lanes) — never copy.
  - PUT `{mode:'external', url: REWRITTEN_URL, jwtSecret: <random>}`; restart through the existing `restartInstance`; write a DOCX for this scenario and open it.
  - Assert, in the lane's locale, exactly the plugin's `loadFailed` heading plus `errApi` text (export `LOADING`/`FAILURES` from `office-hints-stack-fixture.ts`, never copy); no `LOADING`, no office-hints `UNAVAILABLE`, no `errFetch`/`errEditor`/`errEditorEvent`; the DOCX bytes unchanged; then the composer reaches `ready` (existing `composerState`) and the file row is still listed.
  - Console scoping: exactly one console error equal to Chromium's 502 resource message, exactly one 502 response on `${base}/sidebar/onlyoffice/ds/web-apps/apps/api/documents/api.js` captured through `workbenchSession`'s `onResponse`, and exactly one `requestfailed` entry `GET` for that same URL (Chromium reports the 502'd script as failed too; observed in the exact-head stack run of `bf7c058`); `pageErrors` and `externalRequests` empty. No existing allowlist is widened.
  - If the observed UI differs from this (other key, timeout path, blank), stop and report — the spec is revised, the assertion is never loosened.
  - Restore on every path, following `officeIdleScenario`'s pattern (`office-idle-stack-fixture.ts:205-207`: `retiringOnError` for the failure path, then the same restore called again on success), so a failed restore never hides the scenario's own failure: `PUT {mode:'bundled'}`, GET reads it back, restart, then `documentServerReady` (`office-hints-stack-fixture.ts`) proves the bundled Document Server is reached again; restoration failures fail the lane.
  - Evidence line: failure keys, the office-hints `hints` shown above the panel, time to failure, restore confirmed; the JWT never appears anywhere. If the restart receipt of an idle-stopped instance differs from `restartInstance`'s expected `{status:'starting'}`, stop and report rather than loosening it.
    Update `docs/LOCAL_STACK.md` (:144 list, :194-199 evidence table) and `platform/test/README.md` stack evidence.

- [x] 1.5 Fix pass 1: the pairing judge covers console + response + `requestfailed` (each exactly one, same URL); stack `testTimeout` raised by this lane's derived upper bound with the derivation in `vitest.config.ts`, per that file's convention; integration cases for surviving mutants (two paired 502s, non-conforming listener/file/provider fakes, the failure-key verdict as a pure helper); the guide's 「打开失败」 advice distinguishes a just-restarted bundled Office service (reopen shortly) from a persistent failure (tell the administrator).

## 2. Verification

- [x] 2.1 `openspec validate external-document-server-failure --strict --no-interactive`, `openspec validate --specs --strict --no-interactive` after archive; `pnpm check`.
- [x] 2.2 Local exact-head `pnpm test:stack`: the new scenario's evidence (failure text, time, restore), console errors limited to the scenario's expected failure, inventory fence clean.
- [x] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy` (required because `platform/test/` changes), confirmed cleanup.
