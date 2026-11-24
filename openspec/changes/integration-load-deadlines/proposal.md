# Integration load deadlines: main-table sites

## Why

Issue #687 lists 13 integration sites, outside #656's eight files, that failed intermittently in full `pnpm test:integration` runs at 1-minute load 15–116. Nothing shows the product or the scripts misbehaving: these are test-reliability defects in the exact-head merge gate. This change is **slice 1** of #687 and covers the four main-table rows. Line numbers refer to main `139a261`.

- **#1 `docker-evidence-command`: the inner wait equals the case budget (class A).**
  - `runGate` runs `spawnSync` with `timeout: 5000`, `killSignal: 'SIGKILL'` (`platform/test/docker-evidence-command.integration.test.ts:39-54`).
  - The six cases (`:60-123`) give no budget, so they inherit vitest's 5000 ms: the integration project sets no `testTimeout` (`vitest.config.ts:23`).
  - Under load the child is killed at 5 s. `status` is then `null`, and the case fails as `expected null to be 1` (`:109`, `:119`), which names no phase.
- **#2 `volumes-fixture`: the stall deadline hits the wrong request (class C).**
  - `runUserVolumes(socket, 200, 1_000)` (`volumes-fixture.integration.test.ts:178`) puts `AbortSignal.timeout(200)` on **every** acceptance request (`volumes-fixture.ts:22-34`).
  - That includes the four collision `GET`s (`:67-71`) that precede the stalled `POST /volumes/create`.
  - The test's mock records a cancellation only for a rejected `POST /volumes/create` (`volumes-fixture.integration.test.ts:19-43`).
  - Under load a probe `GET` reaches 200 ms first. The single aggregated error is then that probe's, `cancellations` stays empty, and the case fails with `Canonical mutation cancellation was not observed` (`:208-210`).
- **#3 `instance-lifecycle`: the ownership wait is shorter than the script's own steps (class D).**
  - `ownershipEventually` waits `EVENTUALLY_MS = 5_000` (`instance-lifecycle.integration.test.ts:28`, `:437-445`) for `dev:bg` to publish `.run/dev.pid`.
  - Before that, `scripts/dev-server.sh` takes the lock (`:20-29`), runs `pnpm build:web` (`:65`), then an Engine preflight bounded at 10 s (`:67-68`), and only then starts main and writes the PID (`:71-72`).
  - Its case has a 60 s budget (`:518`). Under load the wait timed out five times. #312 saw the same timeout and closed it as UNKNOWN.
- **#4 `instance-lifecycle`: an "observed" fact is bound to the 5 s window (class C).**
  - The two induced-timeout cases (`:612`, `:626`) require `lock` and `webBuild` to have been seen inside the same 5 s window (`:616`, `:640`). The failed-preflight case also requires `closedMs < 5_000` (`:644`).
  - Under load `build:web` alone takes more than 5 s. `webBuild` is then `null`, which fails as `[ 'number', 'object' ]`.
  - The cases exist to prove what the timeout evidence records while the preflight is held or fails, not how fast the web build is.

## What Changes

- **#1:**
  - The six cases declare an explicit case budget as a named constant.
  - `runGate` runs its child through the existing `caseSpawn` (`platform/test/trusted-docker-fixture.ts:197-225`), as #656's sync sites do. It caps the child at the whole budget with `SIGKILL`, so the remaining budget always cuts it.
  - A kill at the deadline fails as `docker evidence gate: killed at the case deadline after Nms; descendants: not observed`, never as a `null` status.
  - One new case makes the stand-in `gh` hang under a short case budget and asserts that message.
- **#2:**
  - In `runUserVolumes`, the stall bound (`requestTimeoutMs`) applies only to acceptance **mutations**. Acceptance **reads** (the four collision `GET`s and the post-create inspections) take the read bound, the existing second parameter (`cleanupTimeoutMs`), which cleanup already uses.
  - The signature and the defaults are unchanged. `volumes.docker.test.ts:10` uses the defaults (10 s and 10 s) and behaves as before.
  - The cases that call `runUserVolumes` declare a named case budget. The fixed 2 s `rescued` watchdog becomes a value derived from the read and stall bounds, with its ledger in a comment.
  - One new case delays a collision `GET` past the 200 ms stall bound but inside the read bound, and still requires the create's own cancellation to be the single aggregated error.
  - The success case passes the read bound as its stall bound too, since no stall is under test there.
- **#3:**
  - `ownershipEventually` takes its window from the caller. The case passes a named `OWNERSHIP_MS` with a stated basis: lock, `build:web`, and the script's own 10 s preflight bound must all fit. The successor `dev:bg` wait in the same case gets the same bound.
  - The case's budget becomes a named constant above an itemized ledger of its waits and cleanup.
  - `eventually` and its other callers keep `EVENTUALLY_MS`.
- **#4:**
  - The induced-timeout cases keep the 5 s window as the **lower** bound. `ownershipTimeout`'s `waitedMs >= 5_000` contract (`:589`) is kept.
  - After the window, the wait continues until the facts each case requires have been observed:
    - held preflight: `lock` and `webBuild`;
    - failed preflight: those two, plus the command closed.
  - A hard cap ends the wait. The induced cases declare a named budget whose ledger (setup, cap, the held command's own preflight exit, cleanup, reserve) stays strictly under it. Past the cap, the timeout still throws its evidence, so a missing fact fails attributably rather than as `Test timed out`.
  - `closedMs < 5_000` is relaxed on purpose. Under load the failed preflight closes only after `build:web`, so after any 5 s window. `waitedMs >= 5_000` still carries "an early exit does not shorten the wait" (design § #4).
  - One new committed case runs the held preflight with a 100 ms window. It is red under the mutant that ignores `awaited` (`webBuild` null) and green after.

No retry or skip. The only weakened assertion is `:644`'s, relaxed on purpose and disclosed above. Product and script semantics are unchanged: `platform/src/**` (including the critical path `platform/src/orchestrator/`), `scripts/*.mjs`, `scripts/dev-server.sh`. `vitest.config.ts` is unchanged.

The PR says `Refs #687`. The issue stays open for the custody rows (#5–#8, after #690 and #692) and the secondary table (#9–#13).

## Triage

```text
Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: three integration files and one fixture; a wrong bound turns a slow pass into a false failure, a too-wide one hides a real hang; #2 must keep the stall cancellation and cleanup's separate bound; #4 must keep the 5 s window contract and the held command still running at the timeout
Selected risk packs: Concurrency / shared state / ordering (which request meets which deadline; waits synchronized on events, not on wall-clock windows); Error handling / rollback / partial outputs (timeouts and kills fail with the phase, not a null status or an unrelated assertion)
Evidence floor: the #2 delayed-probe case red on the old wrapper and green after; mutants (a)–(c), which are the reds of the #1 hang case and the #4 100 ms-window case; the three files green; 5 loaded full pnpm test:integration runs (load ≥ 13, < 67) with load and result; pnpm check; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `integration-test-budgets`: the main-table sites of #687 fail attributably under load, and their "observed" assertions synchronize on events. The capability exists only in unarchived changes, so archive order is `integration-sync-child-budgets`, then `integration-async-wait-budgets`, then this change.

## Impact

- `platform/test/docker-evidence-command.integration.test.ts`
- `platform/test/volumes-fixture.ts`, `platform/test/volumes-fixture.integration.test.ts`
- `platform/test/instance-lifecycle.integration.test.ts`

Unchanged: `platform/src/**`, `scripts/**`, `vitest.config.ts`, `volumes.docker.test.ts`, `observeHttp`'s default (`gateway-http-fixture.ts:207`, the secondary table's #11).

## Risk packs

- **Concurrency / shared state / ordering — selected.** #2 separates the stall from the reads. #4 waits for events after the window. Tasks 1.2–1.4.
- **Error handling / rollback / partial outputs — selected.** #1's kill names its phase. #4's cap still throws its evidence. Tasks 1.1, 1.4.
- **Not selected:** secrets (no new field; messages carry no paths or output), product code, release.

## Acceptance-criteria mapping (#687)

- **Loaded runs** (5 loaded full `pnpm test:integration` runs, load ≥ 13 and < 67, none of the nine files failing): this slice records the runs and reports the three files it covers. The issue's AC1 closes with the last slice. Task 2.3.
- **A/B sites have explicit budgets and inner deadlines strictly inside them; a timeout names its phase:** #1 here. #9, #12 and #13 are in the secondary-table slice. Task 1.1.
- **C sites do not depend on wall-clock windows; each has a distinguishing case or an event-sync explanation:** #2 (the delayed-probe case) and #4 (the 100 ms-window case) here. #8 and #10 are in later slices. Tasks 1.2, 1.4.
- **Secondary table: budgets and attribution.** Later slice.
