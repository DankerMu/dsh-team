# Integration async-wait budgets

## Why

This is the second and final slice of #656. The first slice, PR #678 (`integration-sync-child-budgets`), bounded the synchronous children of sites #1, #2, #4 and #8. This slice covers the async-wait sites, the stale #630 comments and the three sibling fixtures that slice 1 left for later. Line numbers are on main `f23a328`.

- **#3** `egress-capture.integration.test.ts:118-130` (the refusal cases) runs on the default 5 s budget. It awaits `fakeCapture(...).started`, which spans:
  - two nested cold Node starts (fake sudo, fake tcpdump);
  - the listen wait (`LISTEN_MS = 15_000`, `egress-capture.ts:15`);
  - the SIGINT round trip and the close wait (`CLOSE_MS = 15_000`, `:17`);
  - `confirmExited`'s hard-coded 2 s (`:162`).

  PR #637 observed a bare `Test timed out in 5000ms` at load 84.5.

- **#5** `chrome-start.integration.test.ts:132-184`: `ACK_WAIT_MS = 5_000` (`:45`) equals the case's default 5 s.
- **#6** `instance.integration.test.ts:361-430`: `READINESS_FAILURE_WAIT_MS = 5000` (`:359`) equals the case's default 5 s. It starts at `:387`, after the fixture, registration and start. Its fetches are unbounded.
- **#7** `document-server-net-script.integration.test.ts`: one `SETTLE_MS = 10_000` deadline (`:70`) is shared by the marker wait and the post-TERM exit wait.
- **Stale comments:** `chrome-start.integration.test.ts:43-44` and `instance.integration.test.ts:357-358` still say "tracked as a #630 follow-up", but #630 is closed.
- **Siblings deferred by slice 1:** `main-startup-fixture.ts:120`, `onlyoffice-token-fixture.ts:80`, `ci-vps-worker-fixture.ts:149`.

## What Changes

- **#3**
  - The refusal cases declare `CASE_MS`. Its basis is the time breakdown above.
  - `egress-capture.ts` gains optional numeric `listenMs`, `closeMs` and `exitConfirmMs` bounds on `Boundary`. `LIVE` keeps the 15 s / 15 s / 2 s defaults, so docker-lane callers and `install-dialog-fixture` are unchanged.
  - Only `fakeCapture`'s refusal calls pass bounds, derived from the case's remaining budget. `exitConfirmMs` defaults to 2000, so the direct `confirmExited` test (`:295-299`, `'tcpdump exit unconfirmed'`) keeps passing. Attribution may only append after that message.
  - A timeout appends to the existing message, without inserting into `never listened: <first>`. The appended text reports the listen phase with whether the spawned child is alive, or the close phase with whether the tcpdump pid is alive. It never contains the substring `listened after`, so a timed-out case cannot satisfy the `'listened after'` regexes. Liveness comes from the injected `boundary.kill(pid, 0)`: ESRCH means gone, and success or EPERM means alive, matching `confirmExited`'s convention. The sudo child also reports `exitCode`/`signalCode`.
- **#5**
  - The receipt-fault case takes its deadline before setup. `receiptWriteFault` gains a `deadline` field, which `afterEach` clears. `failAcknowledgedReceipt` bounds its wait with `caseBudget(deadline).limit`.
  - On ack timeout, including `limit`'s deadline-passed throw, it records phase, elapsed and the spawned child's liveness (`process.kill(pid, 0)`) into `receiptWriteFault` before `stopChild`, and only then throws. The case's own throw (`:170-172`) carries them. `launchFailure` (`scripts/probe-dsh-api-cdp.mjs:351-357`) drops the original message and the case asserts no `cause`, so this is the only path.
  - The reserve covers `stopChild`, `assertGone` and `rescueChrome`. The design states their bounds.
- **#6**
  - The case deadline is taken before `fixture()`. Each poll fetch is bounded by the remaining budget (`AbortSignal.timeout`) through `caseBudget(deadline).limit`, and the reserve covers the `:417` gateway fetch and `f.close()`.
  - Every timeout exit reports elapsed, the poll count and the instance row's status from the DB. The exits are `limit`'s deadline-passed throw, an aborted fetch's `TimeoutError` and the loop's own deadline throw.
- **#7**
  - The marker wait and the exit wait each get their own deadline, `READY_MS` and `EXIT_MS`, started when that phase begins.
  - `timedOut` becomes `false | 'ready' | 'exit'`. It stays `false` when nothing timed out, so the existing `toEqual({… timedOut: false …})` assertions are unchanged. The returned object gets no new key.
  - A new deterministic case checks that the exit phase gets its full `EXIT_MS`. The holder exposes the exit bound it actually used through a separate test-only return, not the result object. The case asserts that bound equals `EXIT_MS` after a slow marker, injected with `STUB_DELAY` on one `-S` call using the absolute `/bin/sleep`, after the stub writes its log line.
    - Under the shared deadline the observed bound is `SETTLE_MS − t`, which varies continuously with t and so practically never equals `EXIT_MS`. The case asserts `toBe(EXIT_MS)`, which makes it deterministically red.
    - After the split it is green.
  - `READY_MS` is the existing settle headroom plus the injected delay D = 1 s. `CASE_TIMEOUT_MS` rises to `READY_MS + EXIT_MS + reserve`, with the arithmetic stated.
- **Comments.** The two stale `#630` comments are rewritten to state the derived relation.
- **Siblings.** Each of the three deferred siblings gets a verdict in the PR: changed or not, with the reason.
- **Spec.** A new requirement in `integration-test-budgets` names the cases and gives the attribution content per site.

No retry, no skip, and no change to existing assertion content. Product and `scripts/*.mjs` semantics are unchanged. `vitest.config.ts` is unchanged.

## Triage

```text
Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: a wrong derived bound turns a slow pass into a false failure; egress-capture defaults feed docker lanes and install-dialog-fixture; attribution wording could make a timed-out refusal case falsely pass; attribution must not leak the egress canary or the chrome SECRET
Selected risk packs: Concurrency / shared state / ordering; Error handling / rollback / partial outputs
Evidence floor: #3 red→green with a temporary never-listening fake mode (before: bare Test timed out in 5000ms; after: attributed); #7 exit-bound case red under the shared deadline, green after; each changed file green; 5 loaded full pnpm test:integration (load ≥ 13); pnpm check; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `integration-test-budgets`: this capability is introduced by `integration-sync-child-budgets` and is not yet archived; archive that change first. This change adds the async-wait requirement.

## Impact

- `platform/test/egress-capture.integration.test.ts`
- `platform/test/egress-capture.ts`
- `platform/test/chrome-start.integration.test.ts`
- `platform/test/instance.integration.test.ts` (761/800 lines)
- `platform/test/document-server-net-script.integration.test.ts`
