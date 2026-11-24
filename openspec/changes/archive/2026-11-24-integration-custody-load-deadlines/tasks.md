## 1. Implementation

- [x] 1.1 Measuring pass: `CASE_MS` and `SPENT_CASE_MS` temporarily at 60 s. One `custodyCase` wrapper records the callback and cleanup time per held case, plus start-to-leaf-ready per case and in #7. Five loaded full `pnpm test:integration` runs; record the maxima, then revert.
- [x] 1.2 #5/#6: `CASE_MS` re-checked against the measured callback maximum (kept, with its basis comment); `RESERVE_MS` re-checked; the `custodyCase` cases' `20_000` become `CASE_MS`; the comments at C:34, :70 and :673-674 are updated; `LEAF_READINESS_MS` re-derived if readiness binds.
- [x] 1.3 #7: re-checked against the measured setup; the precondition wait was unreachable, so it is not added and the comment argues why (proposal § Outcome).
- [x] 1.4 #8: move `waitFor` into `trusted-docker-uncaptured-fixture.ts` (exported; F has no room) with a predicate parameter, and use it in the uncaptured test (`() => existsSync(p)`) and in C. Wait for `base`, then an invocation directory with `launch.json`, then `child.json`, under one `until`; the named expiry error; one measured run confirming the orphaned start CLI writes `launch.json`.
- [x] 1.5 Mutants, each red, then reverted:
  - on the final constants: #7's precondition wait removed, with fast (unloaded) setup → red at the `command status` assertion. If the wait is unreachable, it is dropped instead (proposal § #7);
  - #8's wait removed, with a temporary ~4 s `Atomics.wait` in the start CLI's `own` spawn wrapper (F:301-310) → ENOENT instead of the `AggregateError`.

## 2. Verification

- [x] 2.1 The custody, retirement and uncaptured integration files green; `pnpm lint` (`max-lines` counts for C and F reported), `pnpm typecheck`, `pnpm check`.
- [x] 2.2 Five loaded full `pnpm test:integration` runs on the final constants (load ≥ 13 and < 67), with each run's load and result in the PR.
- [x] 2.3 PR with `Refs #687`, naming slice 3.
- [x] 2.4 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, with confirmed cleanup.
