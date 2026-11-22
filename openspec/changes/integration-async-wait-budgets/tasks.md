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

See `design.md` § Must preserve. Also: the 800-line and complexity limits. `instance.integration.test.ts` had 761 physical lines (797 after review round 1), and #6's case complexity is about 11 of 15.

## 1. Implementation

- [x] 1.1 #3: the egress-capture refusal cases.
  - Add optional bounds on `Boundary`, with `LIVE` defaults.
  - Refusal cases declare `CASE_MS` and pass derived bounds.
  - Attribution is appended at the end of the message and never contains `listened after`.
  - The listen phase reports the spawned child's liveness. The close phase reports the tcpdump pid's liveness. Liveness comes from `boundary.kill(pid, 0)`: EPERM means alive, ESRCH means gone.
  - `exitConfirmMs` defaults to 2000. The `confirmExited` test at `:295-299` is unchanged.
- [x] 1.2 #5: the receipt-fault case.
  - Take the case deadline before setup and store it in `receiptWriteFault.deadline`, cleared in `afterEach`.
  - Bound the ack wait with `caseBudget(deadline).limit`.
  - On every timeout exit (including `limit`'s deadline-passed throw), record phase, elapsed and liveness before `stopChild`. The case's own throw carries them.
  - State the reserve.
- [x] 1.3 #6: the readiness-failure cases.
  - Take the deadline before `fixture()`.
  - Bound each fetch by the remaining budget.
  - The reserve covers the gateway fetch and `f.close()`.
  - Every timeout exit reports elapsed, the poll count and the DB status: the `limit` throw, an aborted fetch and the loop's deadline.
- [x] 1.4 #7: the holder script.
  - Add `READY_MS` and `EXIT_MS`, each started per phase. `timedOut` becomes `false | 'ready' | 'exit'`, with no new key in the result. `CASE_TIMEOUT_MS = READY_MS + EXIT_MS + reserve`.
  - Add a `STUB_DELAY` stub on one `-S` call (`/bin/sleep`, after the log line) and a test-only exit-bound observation.
  - New case: after a slow marker (D = 1 s), the observed exit bound (after review round 1: the deadline `settle` actually polled, minus `termAt`) is `toBe(EXIT_MS)`. Show it red with the observation ported temporarily into the shared-deadline holder (`deadline − termAt` ≠ `EXIT_MS`), and green after. Existing failure cases keep `timedOut: false`.
- [x] 1.5 Rewrite the two stale `#630` comments.
- [x] 1.6 Give a verdict for each of `main-startup-fixture.ts:120`, `onlyoffice-token-fixture.ts:80` and `ci-vps-worker-fixture.ts:149`: change it under the same rule, or record why not. The verdicts go in the PR.
- [x] 1.7 #3 red→green: add a temporary never-listening fake mode, which is not committed. Before: bare `Test timed out in 5000ms`. After: the attributed listen-phase message. Record both texts.
- [x] 1.8 (added after the first loaded runs) Give every remaining `fakeCapture` case in `egress-capture.integration.test.ts` a declared budget and derived bounds, as for the refusal cases; and change `main-startup-fixture.ts:120` under the same rule, since its 5 s listener wait equals its callers' default 5 s budget (`subnet-startup`, `document-server-startup`). Each red→green. Failures of the loaded runs outside the issue's eight files are filed as their own issue.

## 2. Verification

- [x] 2.1 Each changed file is green. Run `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [x] 2.2 Five full `pnpm test:integration` runs at 1-minute load ≥ 13, using bounded generators that are stopped afterwards. Record the load and result of each run.
  - First loaded runs (implementer, before 1.8): 4/5 green and then 2/5 green. Failures included `egress-capture.integration.test.ts:196` (a non-refusal `fakeCapture` case on the 5 s default, AC5), which led to task 1.8. Two fake races then showed at load ~100: sudo registered SIGINT forwarding after the spawn, and the pid file was written after the spawn. Both were fixed in the fakes.
  - Final tree, 14 bounded generators per run, every run 177/177 files and 3266/3266 tests: run 1 load 15.7→41.6, run 2 30.7→46.5, run 3 35.2→45.4, run 4 33.9→49.6, run 5 37.2→45.5. No residue (`pgrep`).
  - Load-sensitive failures in files outside the issue's eight are filed as #687.
- [x] 2.4 Review round 1 fix pass: committed attribution tests for #3 (never-listening, stuck-close, `liveness()` branches), #5, #6 and main-startup; #7 observes the bound `settle` actually used; the main-startup reserve rises to 5 s (worst chain 14.2 s < 15 s); one shared `DRAIN_MS`. Each new case is red when its bound or suffix is reverted. Two further loaded full runs at load 13.6→62.3 and 50.5→72.0: 177/177 files, 3278/3278 tests. Deferred, uncovered: the egress `exit wait expired` suffix, #6's `wait expired` branch (it needs a real 5 s), and main-startup attribution through `observeStartup` (no injection seam).
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, with confirmed cleanup.
