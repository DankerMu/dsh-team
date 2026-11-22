# Office idle lane strength

## Why

This change is slice C of #657 and covers C1 and C3. Line numbers are on main `f23a328`.

C2 (attributing the keep-alive) moves to its own later slice. By code, the DSH workbench's own SSE `/plugins/events` is a tracked live connection (`gateway/routes.ts:103`, `connections.ts`), and any activity restarts the idle timer (`orchestrator/idle.ts:177`, `:239`). A workbench page alone therefore probably keeps the instance up. Making the hold attributable needs a route-level restriction from page load inside the shared `editAndSave`/`workbenchSession` helpers, plus a restricted negative control. That is a measurement-first design of its own.

- **C1 — restore not asserted.** The success-path restore is a missing link at two places:
  - `loaded` assigns `idle.restore = await idleMinutes(admin, 1)` (`office-idle-stack-fixture.ts:187`);
  - `officeIdleScenario` calls it on the success path (`:212`).

  No integration case drives either, and no stack read-back exists. If the returned restore is dropped at `:187`, or the `:212` call is deleted, every layer still passes and the platform keeps one idle minute.

- **C3 — order not locked.** `loaded` runs `fontsShown` before `idleMinutes` (`:186-187`). The closure (`:184-189`) is unreachable from any test, so swapping the two lines passes.

The idle lane (`platform-stack.stack.test.ts:551`) is followed by `officeExternalScenario` (`:553`), which relies on A ending idle-stopped. Nothing here changes that end state.

## What Changes

- **C1.**
  - `officeIdleScenario(lane, body = officeIdle)` takes an injectable body. An integration case gives it a stand-in body that assigns a recording `idle.restore`, and asserts the success path calls the restore exactly once.
  - `loaded` becomes an exported function (C3 below). An integration case drives its success path with a stand-in hold and a request-recording admin. After it returns, `idle.restore` is no longer the no-op, and calling it PUTs the original configuration. Together with the existing `idleMinutes` case (`office-idle-stack-fixture.integration.test.ts:87-101`), this pins the PUT sequence `[{…original, idleMinutes: 1}, original]`.
  - Inside `officeIdleScenario`, the stack lane snapshots `runtime-config` before the lane and deep-compares a read-back after the restore. The evidence records only `restored: true`. Only equality matters; the five fields (`idleMinutes`, `cpuCores`, `memoryMiB`, `maxRunningInstances`, `defaultPermissionTier`, `admin/runtime-config.ts:8-14`) are not secret.
- **C3.** Export `loaded(admin, email, operator, idle, readFonts, hold = heldRunning)`, which returns `{ fonts, hold }`. An integration case makes `fontsShown` fail, then asserts zero runtime-config PUTs and that `idle.restore` is still the no-op.
- **Evidence.** `officeIdleLine` gains `restored`. The integration test `:162-186`, which uses `toEqual`, and `docs/LOCAL_STACK.md:199` are updated, and all existing fields stay.

## Triage

```text
Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: idle stack lane; a wrong restore assertion would leave the platform's idle minutes changed; the injected seams must not change the lane's behaviour or the external lane's idle-stopped start state
Selected risk packs: Concurrency / shared state / ordering (font check before idle change); Error handling / rollback / partial outputs (restore on success); Config / project setup (runtime-config returns to its snapshot)
Evidence floor: C1 mutants (:187 drop, :212 delete) and C3 mutant (:186/:187 swap) red at the integration layer, green after; exact-head pnpm test:stack green with restored: true; pnpm check; exact-head VPS lane (repository gate for platform/test changes)
```

## Capabilities

### Modified Capabilities

- `stack-verification`: the Office idle lane restores the runtime configuration and changes the idle minutes only after the font check.

## Impact

- `platform/test/office-idle-stack-fixture.ts`
- its integration test
- `docs/LOCAL_STACK.md:199`

`platform-stack.stack.test.ts` is unchanged; its 794/800 effective lines leave no room. The snapshot and the read-back add two administrator GETs. They are not itemised, like the lane's other administrator reads (the `idleMinutes` GET/PUTs and the row and audit reads in `heldRunning`/`idleRetired`), and they fit inside the stated margin (`vitest.config.ts:59-61`). `vitest.config.ts` is unchanged.
