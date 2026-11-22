## Risk packs

- **Error handling, rollback and partial outputs (selected).** Cleanup never replaces the case failure, and every residual is labelled by phase. Tasks 1.1, 1.2a, 1.2b, 1.3.
- **Not selected:** concurrency (the stop ordering is unchanged), product code, secrets, config.

## Acceptance-criteria mapping (#662)

- **AC1** (a new `rm`-failure case, red before and green after) → 1.3.
- **AC2** (the SIGTERM-ignoring case reads that SIGKILL retired the group, and a failed SIGKILL call carries the `SIGKILL` label) → 1.1, 1.2b, 1.3.
- **AC3** (the dev-watch file passes in `pnpm test:integration`) → 2.1.

## Must preserve

- The four `it.each` environment cases, the attribution case (`:301-327`) and their assertions.
- `CASE_MS`, `STOP_MS`, `KILL_MS`, `REPORT_MS` and the deadline derivation.
- The stop → rm → decide order.
- The `attribute` text, `signalGroup` semantics, and `scripts/dev-watch.sh`.
- The SIGTERM-ignoring case's other assertions: it ends before `caseEnd`, the group is absent, and the root is ENOENT.

## 1. Implementation

- [x] 1.1 Make `stop()` return phase-labelled residuals, as specified in the proposal. Tell a SIGKILL call failure apart from a SIGKILL wait that timed out by where the error came from. In the same step, update the regex at `:345` to the labelled form, anchored `; SIGKILL: retired$`, so that 1.1 stays green.
- [x] 1.2a Add the optional `remove = rm` parameter to `withWatch`. Add no guard yet; behaviour is unchanged.
- [x] 1.3 Add the `rm` failure case as the proposal describes, and record its red output: the error thrown is the `EBUSY` remover error. Also add the parameterized real-`stop` case with the stub `Watch` and the no-call-through `process.kill` spy, which goes green with 1.1.
- [x] 1.2b Add the guard: an `rm` rejection becomes a `rm: <error>` residual segment, and the decision rules then apply. The `rm` case turns green.

## 2. Verification

- [ ] 2.1 Run the dev-watch integration file three times in a row, then `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [ ] 2.2 Run exact-head trusted VPS `pnpm test:docker` and `pnpm test:deploy`; this is the repository gate.
