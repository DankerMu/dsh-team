## 1. Implementation

- [x] 1.1 #1: `GATE_CASE_MS` and `GATE_RESERVE_MS`; `runGate` through `caseSpawn`; the `hangGitHub` case (`exec sleep 8`, a short case budget) (design § #1).
- [x] 1.2 #2: the method-keyed bound in `runUserVolumes` and its comment; `STALL_MS`, `READ_MS`, the derived watchdog and `VOLUMES_CASE_MS`; the `delaysProbe` case with its positive control, reusing the stall assertions (design § #2).
- [x] 1.3 #3: `ownershipEventually`'s wait parameter, threaded through `inducedOwnershipTimeout`/`retiredOwnershipTimeout`, and `ownershipTimeout` asserting `waitedMs >= windowMs`; `OWNERSHIP_MS` for `:473` and `:509`; `OWNERSHIP_CASE_MS` with its ledger (design § #3 and #4).
- [x] 1.4 #4: `awaited`, `INDUCED_CAP_MS` and `INDUCED_CASE_MS` with its ledger; `:644`'s relaxation with its comment; the 100 ms-window case; the `EVENTUALLY_MS` comment (design § #3 and #4).
- [x] 1.5 Required evidence items 1–2: each red→green and each mutant recorded for the PR.

## 2. Verification

- [ ] 2.1 The three files green alone; `pnpm lint`, `pnpm typecheck`, `pnpm check`.
- [ ] 2.2 PR with `Refs #687` (not `Closes`), naming the rows left for later slices.
- [ ] 2.3 Five loaded full `pnpm test:integration` runs (design § Required evidence 5), with each run's load and result in the PR.
- [ ] 2.4 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, with confirmed cleanup.
