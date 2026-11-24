# Design

Change surface: the files in the proposal's Impact list (the five original files, plus `main-startup-fixture.ts` and its three callers from task 1.8).

Must preserve:

- **Assertions.** Every existing assertion's content stays unchanged, including:
  - the refusal regexes (`/never listened: sudo: .*pid never recorded/`, `'listened after the'`, `'listened after'`);
  - the exact `toEqual(new Error(...))` at `egress-capture.integration.test.ts:170`;
  - the egress `payload-must-not-stay` canary;
  - chrome-start's `not.toHaveProperty('cause')` and its SECRET absence;
  - the holder `toEqual({… timedOut: false …})` and the V4/V6 call sequences.
- **Egress defaults.** The `egress-capture.ts` `LIVE` defaults (15 s / 15 s / 2 s) stay, as does the direct `confirmExited` test (`:295-299`, which relies on the 2 s default), for the docker lanes and for `install-dialog-fixture.integration.test.ts` (`:183`, `:209`, `/browser failed; stop: .*incomplete capture/`).
- **Holder cleanup.** The holder's forced group kill.
- **Out of scope.** `scripts/*.mjs`, `platform/src/**` and `vitest.config.ts`.

Must add/change:

- **#3.**
  - Optional `listenMs`, `closeMs` and `exitConfirmMs` on `Boundary`, with `LIVE` defaults. `egress-capture.ts` takes plain numbers and does not import fixtures.
  - The refusal cases get `CASE_MS` and pass derived bounds.
  - The attribution is appended at the end of the message and never contains `listened after`.
- **#5.** A `receiptWriteFault.deadline` field; `caseBudget(deadline).limit` for the ack wait. Every timeout exit records phase, elapsed and liveness into `receiptWriteFault` before `stopChild`, including `limit`'s deadline-passed throw, and only then throws. The case's own throw carries them. Importing `trusted-docker-fixture.ts` under `vi.mock('node:fs/promises')` must have no side effects; check this.
- **#6.** The deadline is taken before `fixture()`. Each fetch is bounded through `caseBudget(deadline).limit` and `AbortSignal.timeout`. Every timeout exit reports elapsed, the poll count and the DB status: `limit` throwing, an aborted fetch and the loop's deadline throw. The case's complexity is about 11/15, so the wrapping goes into a helper if needed.
- **#7.** `READY_MS` and `EXIT_MS`, started per phase. `timedOut` is `false | 'ready' | 'exit'`. A test-only exit-bound observation is kept separate from the result object.

Governing invariant: every inner wait in the named cases expires strictly before its case budget. Its failure is attributable, and no timed-out case can satisfy an existing assertion.

Reuse:

- `caseBudget(deadline).limit` provides min(ms, remaining) and throws when the deadline has passed. `.stalled(phase, since, pid)` gives phase, elapsed and liveness (`trusted-docker-fixture.ts:129-183`). #5 and #6 use `limit`.
- `stalled`'s text format, `<phase> after <ms>ms`, is not used at #3, because "after" could collide with the `listened after` regexes. The timeout fires inside `egress-capture.ts` (`within()` returns `undefined`, `:233`, `:253-259`), so the suffix is built there. Liveness comes from the injected `boundary.kill(pid, 0)`: ESRCH means gone, success or EPERM means alive (a real root tcpdump returns EPERM), as in `confirmExited` (`:160`). The sudo child also gives `exitCode`/`signalCode`. `egress-capture.ts` imports no fixture.
- No second budget primitive.

Budgets (values chosen in implementation, each stated with its basis in a comment):

- **#3.** `CASE_MS` covers two cold Node starts, the listen and close bounds, `confirmExited` and a reserve. The derived listen and close bounds take what remains.
- **#5.** The reserve covers `stopChild` (SIGTERM, then SIGKILL at 8 s; it rejects at 11 s, `scripts/probe-browser-native.mjs:133-146`), `assertGone` and `rescueChrome`.
  - In a normal ack timeout the child is still alive and responsive to SIGTERM, so `stopChild` returns within milliseconds.
  - The design takes a reserve of stopChild's SIGKILL path (8 s) plus 2 s. It does not take the 11 s reject bound: a reject is an independent failure that already attributes itself.
- **#6.** The reserve covers the `:417` gateway fetch and `f.close()`.
- **#7.**
  - `READY_MS` is the existing settle headroom (`SETTLE_MS`, whose basis is the `:22` comment) plus the injected delay D = 1 s.
  - `EXIT_MS` is about 3 s, because a TERM exit comes milliseconds after the marker.
  - `CASE_TIMEOUT_MS = READY_MS + EXIT_MS + reserve`.
  - (Review round 1: `settle` returns the deadline it actually polled against, and the case reports that minus `termAt`, so a shared deadline turns it red: 8047 vs 3000.) The observed exit bound was first `exitDeadline − termAt`. `termAt` is read once when SIGTERM is sent, and `exitDeadline = termAt + EXIT_MS`. The case asserts `toBe(EXIT_MS)`.
  - The bound leaves through an options callback or a separate out-parameter, never the result object.
  - Red run: the same observation, ported temporarily into the shared-deadline holder, gives `deadline − termAt`. That value varies with t and practically never equals `EXIT_MS`. The case is deterministically red because of this inequality, not because the value is smaller (being smaller would need t > `SETTLE_MS − EXIT_MS`). The port is not committed.
  - If the marker is never held, there is no exit wait. A ready-phase timeout gives `timedOut: 'ready'`. The existing failure cases, where the script exits first, still give `timedOut: false`.

Sibling surfaces:

- the egress docker-lane callers and `install-dialog-fixture`, which keep the defaults;
- the slice-1-deferred siblings `main-startup-fixture.ts:120`, `onlyoffice-token-fixture.ts:80` and `ci-vps-worker-fixture.ts:149`, each with a verdict;
- the slice-1 `integration-test-budgets` requirement, which is archived first.

Seams under test:

- **#3:** a temporary never-listening fake mode for red/green. It is not committed. (Review round 1 added committed `silent` and `stuck` fake modes with small injected bounds, plus `liveness()` branch cases; #5, #6 and main-startup gained committed short-deadline attribution cases.)
- **#7:** `STUB_DELAY` on one `-S` call, using `/bin/sleep` after the log write, plus the test-only exit-bound observation.

Required evidence:

- **#3:** before the change, a bare `Test timed out in 5000ms`; after, the attributed listen-phase message.
- **#7:**
  - Before: the exit bound used is `SETTLE_MS − t`, less than `EXIT_MS`.
  - After: it equals `EXIT_MS`.
  - `toEqual` cases unchanged.
- **Loaded runs:** 5 loaded runs.

Non-goals: the sync sites and slice 1's 1.3 verdict list.

Review focus:

- **No false green:** the "listened after" collision.
- **#5:** attribution survives `launchFailure`.
- **#7:** shape compatibility, and determinism of the new case.
- **#6:** bounded fetches.
