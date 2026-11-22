## Risk packs

- **Concurrency / shared state / ordering — selected.** Timer waits run against the case budget, and #7 splits into two phases. Tasks 1.1–1.4.
- **Error handling / rollback / partial outputs — selected.**
  - Timeouts are attributed, and no timed-out case can satisfy an existing assertion.
  - #5's attribution survives `launchFailure`.
  - The holder's group kill is preserved.

  Tasks 1.1–1.4.

- **Not selected:** product code, config, secrets (attribution carries no payload, and the egress canary and chrome SECRET checks are preserved), release.

## Acceptance-criteria mapping (#656, slice 2 of 2)

- **AC1** (explicit budgets; inner waits strictly below them and derived): #3, #5 and #6 → 1.1–1.3. Slice 1 covered the rest. The three deferred siblings get verdicts in 1.6.
- **AC2** (attributed timeouts; red→green) → 1.1–1.3 and 1.7. #3 is the red/green site.
- **AC3** (#7 separate deadlines; deterministic case red→green) → 1.4.
- **AC4** (no stale #630 comments) → 1.5.
- **AC5** (5 loaded runs) → 2.2.
- **AC6** (no retry, skip or assertion change) → must preserve.

This slice completes #656, so the PR uses `Closes #656`.

## Must preserve

See `design.md` § Must preserve. Also: the 800-line and complexity limits. `instance.integration.test.ts` has 761 physical lines, and #6's case complexity is about 11 of 15.

## 1. Implementation

- [ ] 1.1 #3: the egress-capture refusal cases.
  - Add optional bounds on `Boundary`, with `LIVE` defaults.
  - Refusal cases declare `CASE_MS` and pass derived bounds.
  - Attribution is appended at the end of the message and never contains `listened after`.
  - The listen phase reports the spawned child's liveness. The close phase reports the tcpdump pid's liveness. Liveness comes from `boundary.kill(pid, 0)`: EPERM means alive, ESRCH means gone.
  - `exitConfirmMs` defaults to 2000. The `confirmExited` test at `:295-299` is unchanged.
- [ ] 1.2 #5: the receipt-fault case.
  - Take the case deadline before setup and store it in `receiptWriteFault.deadline`, cleared in `afterEach`.
  - Bound the ack wait with `caseBudget(deadline).limit`.
  - On every timeout exit (including `limit`'s deadline-passed throw), record phase, elapsed and liveness before `stopChild`. The case's own throw carries them.
  - State the reserve.
- [ ] 1.3 #6: the readiness-failure cases.
  - Take the deadline before `fixture()`.
  - Bound each fetch by the remaining budget.
  - The reserve covers the gateway fetch and `f.close()`.
  - Every timeout exit reports elapsed, the poll count and the DB status: the `limit` throw, an aborted fetch and the loop's deadline.
- [ ] 1.4 #7: the holder script.
  - Add `READY_MS` and `EXIT_MS`, each started per phase. `timedOut` becomes `false | 'ready' | 'exit'`, with no new key in the result. `CASE_TIMEOUT_MS = READY_MS + EXIT_MS + reserve`.
  - Add a `STUB_DELAY` stub on one `-S` call (`/bin/sleep`, after the log line) and a test-only exit-bound observation.
  - New case: after a slow marker (D = 1 s), the observed exit bound `exitDeadline − termAt` is `toBe(EXIT_MS)`. Show it red with the observation ported temporarily into the shared-deadline holder (`deadline − termAt` ≠ `EXIT_MS`), and green after. Existing failure cases keep `timedOut: false`.
- [ ] 1.5 Rewrite the two stale `#630` comments.
- [ ] 1.6 Give a verdict for each of `main-startup-fixture.ts:120`, `onlyoffice-token-fixture.ts:80` and `ci-vps-worker-fixture.ts:149`: change it under the same rule, or record why not. The verdicts go in the PR.
- [ ] 1.7 #3 red→green: add a temporary never-listening fake mode, which is not committed. Before: bare `Test timed out in 5000ms`. After: the attributed listen-phase message. Record both texts.

## 2. Verification

- [ ] 2.1 Each changed file is green. Run `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [ ] 2.2 Five full `pnpm test:integration` runs at 1-minute load ≥ 13, using bounded generators that are stopped afterwards. Record the load and result of each run.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, with confirmed cleanup.
