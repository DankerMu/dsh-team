## Risk packs

- **Concurrency / shared state / ordering — selected.** The child can exit while the final `ownerIsLive` await is pending; the synchronous recheck closes the window before the signal. Task 1.1, 1.2.
- **Error handling / rollback / partial outputs — selected.** In the race window the outcome changes on purpose: from an ESRCH failure (terminal `failure: 'identity'`) or `true` (retirement) to a quiet `false`. Outside the window, return values and thrown identity errors are unchanged. Tasks 1.1, 1.2; design.md § Must change. The downstream effects of a `false` are covered by the existing case "neither records nor throttles an attempt that had no group to signal" (`trusted-docker-cancellation.integration.test.ts:203`) and the `!signalled` guard in `retireAfterCancellation`.
- **Auth / permissions / secrets — not selected beyond the above.** No identity rule changes; the fix only refuses one more signal.
- **Not selected:** public CLI, config, file IO, schema, resource limits, legacy compatibility, release, docs. `verify:docker` usage and outputs are unchanged.

## Acceptance-criteria mapping (#720)

- **AC1** (unit case: child exits during the last `ownerIsLive`; returns false; `process.kill` not called) → 1.2.
- **AC2** (reverting the fix turns that case red) → 1.2, 2.1.

## Must preserve

- `signalOwnedGroup` still returns `true` after signalling a live, identity-bound group (existing case in `platform/test/trusted-docker-retirement.integration.test.ts`, "reports the group signal it actually sent").
- Already-ended children still resolve `false` with no `process.kill` (existing `it.each` case).
- Identity-changed paths still throw the existing messages (`Trusted Docker child identity changed`, `Trusted Docker child group identity changed`).
- `trusted-docker-cancellation.integration.test.ts` passes unchanged.
- In the race case (design.md § Must change):
  - `ownedCancellation.signalled` stays `false`, so no `retirement.json`;
  - no throttle or trace;
  - no `failure: 'identity'`;
  - `interruption` keeps its first kind.

## 1. Implementation

- [x] 1.1 In `signalOwnedGroup`, add `if (child.exitCode !== null || child.signalCode !== null) return false;` after the final identity check and immediately before `process.kill`, with no await in between.
- [x] 1.2 Add one case using a real detached child, with two rows: exit-by-code (stdin closed, the child exits 23) and exit-by-signal (SIGKILL). Each row sets one half of the recheck and asserts its `exitCode`/`signalCode`.
  - Intercept only the second `ownerIsLive` call (`:167`, imported from `./trusted-docker-record.mjs`): it ends the child per row, awaits its `exit`, then resolves `true`. The first call (`:156`) uses the real implementation.
  - Scope the mock so other cases keep the real `ownerIsLive`, for example with a passthrough `vi.mock` plus a one-time implementation, or a separate test file.
  - Have the `process.kill` spy stub negative-pid calls, so no real group signal is sent.
  - **Red** (1.1 reverted): it resolves `true`, and the stubbed spy records `(-pid, 'SIGINT')`. Dropping only the `exitCode` half turns only the exit-by-code row red; dropping only the `signalCode` half, only the exit-by-signal row.
  - **Green:** it resolves `false`, and the spy saw no negative-pid call.

## 2. Verification

- [x] 2.1 Red run (new case, fix reverted) and green run; `pnpm test:integration platform/test/trusted-docker-retirement.integration.test.ts platform/test/trusted-docker-cancellation.integration.test.ts` plus the new case's file; `pnpm lint`, `pnpm typecheck`, `pnpm fmt:check`, `pnpm dead-code`.
- [x] 2.2 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy` (non-docs change; `dsh-team/docker` status).
