# Split the custody fixture and custody test file by responsibility

## Why

Issue #718, item 4. ESLint `max-lines` (800, blank lines and comments skipped) measures:

- `platform/test/trusted-docker-custody.integration.test.ts` at 800/800;
- `platform/test/trusted-docker-fixture.ts` at 799/800.

Items 1–3 of #718 have to edit both files, so they must be split first, as the issue requires. This is slice 1 of #718. Items 1–3 follow in slice 2 under their own change; #718 stays open until then.

## What Changes

A behavior-preserving move only. No logic, assertion, budget or message changes.

- **`platform/test/case-budget-fixture.ts` (new).** Move the generic case-deadline utilities and their dependency here:
  - `caseBudget`, `caseSpawn` and `CaseSpawn`;
  - `CaseBudget`, which is now exported;
  - `ownerPresent`, which `caseBudget().stalled` calls. Leaving it behind would make `case-budget-fixture.ts` and `trusted-docker-fixture.ts` import each other, and `no-circular` would reject the change.

  Every importer of these symbols is updated to the new home, as found by `grep -rln "caseBudget\|caseSpawn\|CaseSpawn\|ownerPresent" platform/test`. This includes `trusted-docker-audit-fixture.ts`, `main-startup-fixture.integration.test.ts`, `browser-build-fixture.integration.test.ts`, `trusted-docker-fixture.ts` itself and the new custody and deadline files. `pnpm typecheck` catches any that are missed.

- **`platform/test/trusted-docker-process-fixture.ts` (new).** It takes `fixtureProcessCustody` and its private dependencies, `errorCode` and `birthModule`. `recordedProcesses`, `GROUP_MEMBER_RECORD` and `FAKE_PLATFORM_RECORD` stay in `trusted-docker-fixture.ts`, because the fixture template and its cleanup use them there.
- **`trusted-docker-fixture.ts` itself.**
  - The cleanup closure of `createTrustedDockerFixture` (about `:767-813`) is extracted, unchanged, into a module-level function. The function is at 191 of the 200 `max_function_lines`, and slice 2 must edit that cleanup.
  - The file keeps repository preparation, the observer, the sentinel and `withTrustedDockerFixture`.
  - Nothing is re-exported: every symbol has one home.
- **`platform/test/trusted-docker-custody-fixture.ts` (new).** It takes the helpers shared by both custody test files, formerly custody test `:33-241`:
  - `CustodyFixture`, `CASE_MS`, `RESERVE_MS` and `custodyCase`;
  - `terminalEvidence`, `LEAF_READINESS_MS` and `awaitReadiness`;
  - `leafRecord`, `issuedInvocation` and `leafState`;
  - `memberExit`, `memberTiming` and `liveMember`;
  - `TERMINAL_WAIT_MS`, `awaitTerminal` and `cancelHeldCommand`.

  Test files never import from another `.test.ts`.

- **`platform/test/trusted-docker-deadline.integration.test.ts` (new).**
  - **Moved cases:** the readiness wait (`:571`), the release-early and release-blind `it.each` (`:592`, kept with the waits it exercises), the two terminal waits (`:613`, `:625`), the fixture spawn cut (`:641`), the held terminal wait (`:660`), and the start killed at the deadline (`:692`).
  - **Exclusive helpers that move with them:** `SPENT_CASE_MS` and `COMMAND_LAUNCH_MS`.
  - **Budget:** the file calls `vi.setConfig({ testTimeout: CASE_MS })` itself, as the custody file does at `:47`. Without it, three cases would fall back to Vitest's 5000 ms.
- **Headroom.** Every resulting file stays at or below 700 effective lines.

`design.md` is omitted: compact, mechanical refactor.

## Triage

```text
Issue type: refactor (test infrastructure)
Fixture level: compact (override: the concurrency and legacy-compatibility triggers touch test scheduling and test-file layout only, with no product state, entrypoint or shared resource)
Upstream suggested level: absent
Blast radius: every custody/trusted-Docker integration case and the generic case-budget users; a lost case or a changed import would silently drop coverage
Selected risk packs: Legacy compatibility (every existing case still runs, same names, same count); Concurrency / ordering (moved deadline cases now run on their own worker)
Evidence floor: identical integration test count and names before/after; pnpm test:integration; pnpm lint (max-lines with margin); dead-code; duplicate-code; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `trusted-docker-verification`: the custody fixture and the custody cases are split by responsibility with no behavior change.

## Impact

- `platform/test/trusted-docker-fixture.ts`, `platform/test/trusted-docker-custody.integration.test.ts`
- new `platform/test/case-budget-fixture.ts`, `platform/test/trusted-docker-process-fixture.ts`, `platform/test/trusted-docker-custody-fixture.ts`, `platform/test/trusted-docker-deadline.integration.test.ts`
- the import lines of every importer of the moved symbols
- The PR carries `diff-limit-exempt`: a pure move counts its lines twice.
