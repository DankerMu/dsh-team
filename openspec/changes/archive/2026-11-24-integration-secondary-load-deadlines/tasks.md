## 1. Implementation

- [x] 1.1 Measuring pass: the four files' budgets temporarily at 60 s, with an `observeHttp` settle probe. Five runs at load ≥ 67, warmed up, with short runs discarded; JSON-reporter durations. Record the maxima, then revert everything temporary.
- [x] 1.2 #9: every `withAuditReceipt` call in the file (:152, :194, inside `withBoundExec`) passes the budget; `ordinarySubmission` gets an optional `spawn` (default unchanged), and :425 passes `spawnChild`; the file's default-bound cases get the declared budget, which is above the client timer plus setup and cleanup.
- [x] 1.3 #12: an optional `signal` in `postJson`; per-login bounds from the remaining budget (deadline from `performance.now()`, since `Date` is faked), named by attempt; the declared budget.
- [x] 1.4 #13: a per-rejection bound on `fetch`, named by label; the declared budget, scaled by `rejections.length`.
- [x] 1.5 #11: `HTTP_OBSERVATION_MS` (also in `withUpstream`), with its basis; the websocket file's declared budget above its largest observation sum plus non-observation cost; stop and report if the default must rise.
- [x] 1.6 #10: the ordering and masked-publication comment at :315; if reproduced, expose the masked error as `cause`.
- [x] 1.7 Red attribution probes (hung client, stalled registration, stalled login, stalled proxy request, 50 ms default), each reverted.

## 2. Verification

- [x] 2.1 The four files green; `pnpm lint` (`max-lines` for the websocket file), `pnpm typecheck`, `pnpm check`.
- [x] 2.2 Five loaded full `pnpm test:integration` runs (load ≥ 13 and < 67), with each run's load and result in the PR.
- [x] 2.3 PR with `Closes #687`, opened after #712 merges.
- [x] 2.4 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, with confirmed cleanup.
