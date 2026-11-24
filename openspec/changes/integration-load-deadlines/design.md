# Design: integration load deadlines, main-table sites

Line numbers refer to main `139a261`.

## Must preserve

- **#1:**
  - each case's assertions on `status`, `stdout` and `stderr` (`docker-evidence-command.integration.test.ts:60-123`) are unchanged;
  - the stand-in `gh` stays a controlled external executable, not a mock of the verifier.
- **#2:**
  - the stalled create's cancellation is still the **single** aggregated error, identical to the recorded `cancellation.error`, with `signal.aborted === true` and no `cause` (`volumes-fixture.integration.test.ts:197-222`);
  - exactly one `POST` and one `DELETE` in the stall case;
  - cleanup goes through `rawClient`, not the wrapper, and keeps its own bound. The `delaysCleanup` case (`:156-168`) still delays cleanup's first `GET` 300 ms past the 200 ms stall bound, and passes;
  - the non-stall case still makes its eight `POST`s;
  - the `rescued` watchdog still rescues a stalled connection that acceptance never cancels;
  - `volumes.docker.test.ts:10` calls `runUserVolumes` with the defaults (10 s and 10 s), and its behaviour does not change.
- **#3/#4:**
  - `OwnershipEvidence`'s shape, and the `Timed out waiting for source-main ownership\n<json>` message (`instance-lifecycle.integration.test.ts:446-454`);
  - `ownershipTimeout`'s lower-bound assertion (`:589`) and its closed-set secret checks (`:576-588`);
  - the held-preflight case's `command: { state: 'running', … }` and `pidfile: 'missing'` (`:617-622`), and `code === 1` in both induced cases;
  - `retiredOwnershipTimeout`'s (`:596-602`) cleanup `RETIRED` (`:520-526`);
  - the `settleMs` path at `:648`, `inducedOwnershipTimeout(heldPreflightEngine(), 1_000)`.
- `platform/src/**`, `scripts/**` and `vitest.config.ts` are unchanged.

## Must add/change

### #1 `docker-evidence-command.integration.test.ts`

- `runGate` runs its child through the existing `caseSpawn(caseMs, reserveMs).spawn('docker evidence gate', process.execPath, [entrypoint], options)` (`trusted-docker-fixture.ts:197-225`), as #656's sites do (`profile-seed.integration.test.ts:245`, `ci-vps-proxy-fixture.ts:86`, `browser-build-fixture.ts:222`). There is no second implementation.
  - `caseSpawn` caps the child at the whole budget, with `SIGKILL`, so the remaining budget always cuts it.
  - A kill throws `docker evidence gate: killed at the case deadline after Nms; descendants: not observed`.
- **Budget.** A named `GATE_CASE_MS` (proposed 15 000) is the third argument of all six cases. A named `GATE_RESERVE_MS` (proposed 2 000) covers `mkdtempSync`, the `gh` write, `rmSync` and the assertions. `runGate` calls `caseSpawn` at entry with those two by default.
- **New case.**
  - A `hangGitHub` option writes a `gh` whose body is `exec /bin/sleep 8`. The absolute path is needed because the verifier's `PATH` is the temporary directory alone (`:44-45`), which is the existing cases' isolation and stays. Eight seconds is longer than the old 5 s timeout.
  - The case calls `caseSpawn(3_000, GATE_RESERVE_MS)`, so the cut lands at about 1 s. `caseMs` must exceed the reserve; otherwise `limit` throws `case deadline passed before it started` (`trusted-docker-fixture.ts:140`).
  - It asserts that the throw matches `/^docker evidence gate: killed at the case deadline after \d+ms; descendants: not observed$/`.
  - The `sleep` left after the verifier's `SIGKILL` exits by itself within 8 s, and the design says so. It writes nothing, and the temporary directory is still removed in `finally`.
- **Spec scenario.** It quotes the message with the descendants suffix.

### #2 `volumes-fixture.ts` and its integration test

- **The wrapper** (`volumes-fixture.ts:22-34`) picks the bound by HTTP method:
  - `GET` → the second parameter;
  - any other method → `requestTimeoutMs`, the stall bound.
  - Caller cancellation is still combined with `AbortSignal.any`.
  - The choice keys on the method, never on `ensureUserVolumes`' internal call order. `ensureUserVolumes` sends only `POST`s (`platform/src/orchestrator/volumes.ts:41-47`).
- **The second parameter keeps its name `cleanupTimeoutMs`.** The comment at `:12-13` says it bounds each cleanup request and each acceptance read, and that `requestTimeoutMs` bounds each acceptance mutation.
- **Budget, and a watchdog derived per case.** The test file names `STALL_MS = 200` and `READ_MS = 1_000`, the two values passed at `:178`. Each case's watchdog is its worst legitimate path, with the ledger in a comment, plus a stated margin. This replaces the fixed 2 s (`:183-191`). The watchdog still rescues a connection that acceptance never cancels, and the `rescued === false` assertion is unchanged. The ledgers:
  - **stall and `delaysCleanup` cases:** reads `8 × READ_MS`, and mutations `1 × STALL_MS`. The reads are four collision `GET`s, plus cleanup of user 00 only (`attemptedUsers`): work's `GET`, then home's `GET`, `DELETE` and `GET`.
  - **`delaysProbe`:** the same ledger.
  - **success case:** four collision `GET`s, four post-create inspections (`volumes-fixture.ts:89-91`), and twelve cleanup requests (`GET`, `DELETE`, `GET` per target, `:96-126`), plus its eight `POST`s.
    - It passes `READ_MS` as its stall bound as well. The stall is not under test there, and a 200 ms `POST` under load would be the same class C residual.
    - Its ledger is therefore `28 × READ_MS`.
  - **`VOLUMES_CASE_MS`** is strictly greater than the largest watchdog plus the case's own work, proposed 35 000. It is the third argument of every case that calls `runUserVolumes`.
  - Before this change those cases inherited the default 5 s (`vitest.config.ts:23`). Archive task 36.1 accounted 4 × 1 s + 0.2 s < 5 s (`openspec/changes/archive/2026-11-20-stage-2-dsh-ragflow-office/tasks.md:4347`).
- **New case `delaysProbe`, beside `delaysCleanup`.**
  - The server delays the **first collision `GET`** 300 ms: over the stall bound, under the read bound. It then stalls the create as the stall case does.
  - Positive control: the delayed request is that `GET /volumes/dsh-team-home-…00`, answered `404`, as `expectDelayedCleanup` checks its own (`:66-80`).
  - It runs the stall case's full assertion block: the single error is the create's cancellation, with one `POST` and one `DELETE`.
  - Before the fix it fails with `Canonical mutation cancellation was not observed`. That is the recorded red.
  - It reuses the `DelayedRequest` machinery and the stall assertions through parameterization, not a copied block.

### #3 and #4 `instance-lifecycle.integration.test.ts`

**The wait parameter.** `ownershipEventually(lifecycle, started, wait)` gains one parameter. `inducedOwnershipTimeout` and `retiredOwnershipTimeout` pass it through, and `ownershipTimeout` asserts `waitedMs >= wait.windowMs`.

```ts
interface OwnershipWait {
  windowMs: number; // the PID wait; for the induced cases, also the timeout's lower bound
  capMs?: number; // induced only: hard end, from the case ledger below
  awaited?: (seen, command) => boolean; // induced only: facts observed before timing out
}
```

The shape may differ. The behaviour is fixed:

- a valid PID ends the wait at any time;
- without `awaited`, the wait times out at `windowMs`;
- with `awaited`, it times out at the first poll at or after `windowMs` where `awaited` holds, or at `capMs`, whichever comes first;
- the evidence JSON and the message are unchanged.

**#3: the 60 s case at `:457`.**

- It passes `{ windowMs: OWNERSHIP_MS }`, with `OWNERSHIP_MS` proposed at 20 000. The comment gives the basis: lock, plus `build:web`, plus the script's own 10 s preflight bound (`scripts/dev-server.sh:65-68`).
- The successor `dev:bg` wait at `:509` runs the same build, preflight and health path, so it moves from 10 s to `OWNERSHIP_MS` on the same basis.
- The case budget at `:518` becomes a named `OWNERSHIP_CASE_MS`, with an itemized ledger in a comment:
  - the pass path: ownership 20, `:476` 10, `:485` 2, `:487` 5, `:498` 2, `:502` 5, `:503` 5, `:509` 20 and `:514` 5, about 74 s;
  - plus cleanup's commands step, a 35 s settle (`:248`, `:332-337`), and its main step, `dev:stop` under `observeHttp(…, 35_000)` plus `eventually` 5 s (`:341-345`). That is about 149 s, so `OWNERSHIP_CASE_MS` is proposed at 160 000;
  - the comment also names the existing unbounded registration and fetch (`:477-482`) as outside the ledger.
- `eventually` and its other callers (`:137`, `:344`, `:487`, `:503`) keep `EVENTUALLY_MS`.

**#4: the induced cases at `:612`, `:626` and `:648`.**

- They pass `{ windowMs: EVENTUALLY_MS, capMs: INDUCED_CAP_MS, awaited }`:
  - the held-preflight case awaits `lock !== null && webBuild !== null`;
  - the failed-preflight case also awaits `command.state === 'closed'`;
  - `:648` awaits what the held case awaits.
- **Budget.** The three cases share a named `INDUCED_CASE_MS`, proposed 50 000, with a ledger in a comment:
  - setup: `copyDevRuntime` and migrations (`:257-272`), stated at 5 s;
  - `INDUCED_CAP_MS`, proposed 15 000;
  - the held command's own exit after the cap: the rest of `build:web`, node start, and the script's 10 s preflight (`dev-server.sh:65-68`). This is the step that bounds the held case's retirement, not `settleMs`. Stated at 15 s;
  - root removal plus a reserve.
  - The ledger's sum is strictly less than `INDUCED_CASE_MS`. A cap reached while `webBuild` is still missing therefore fails with the ownership evidence, not with `Test timed out`.
- **The held case cannot overshoot into the preflight's own failure.** The script starts its 10 s preflight only after `build:web` (`dev-server.sh:65-68`), so the command is still `running` at the first poll where `webBuild` is seen.
- **`:644`, `closedMs < 5_000`, is relaxed on purpose.**
  - The failed preflight closes the command only after `build:web`, so under load the close is necessarily after a 5 s window, whatever the fix.
  - Kept: `:589`'s `waitedMs >= windowMs`, which every run asserts and which carries the property "an early exit does not shorten the wait"; `closedMs` is a number; the state is `closed`.
  - Lost: the guarantee that a given run closed before the window ended. The loaded and unloaded runs record each `closedMs`, so the PR shows that the unloaded runs still close inside 5 s.
  - `closedMs <= waitedMs` is not added: it would always hold.
- **New committed case, the distinguishing proof for #4.**
  - The held preflight with `windowMs: 100` and the held `awaited`.
  - It asserts that `lock` and `webBuild` are numbers, that `command.state` is `running`, and `waitedMs >= 100`.
  - Its red is mutant (c), with the new signature and `awaited` ignored: `webBuild` is then `null` at 100 ms, because `build:web` takes longer than that. The old code ignores the window argument and waits 5 s, so it is not a red.
  - It shares `INDUCED_CASE_MS` and goes through the same `retiredOwnershipTimeout` path.
- The `EVENTUALLY_MS` comment (`:26-27`) is updated to say who still uses it.

## Seams under test

- **#1:** the hang case drives the real cut through `caseSpawn`.
- **#2:** the delayed-probe case drives the real wrapper against the test's Unix server.
- **#3:** no deterministic case. It is class D, a budget declaration, and its evidence is the loaded runs.
- **#4:** the 100 ms-window case drives the real `dev:bg` and the event-synchronized wait.

## Required evidence

1. **Red→green on the old code** for #2. The delayed-probe case is run alone against the old wrapper, where it fails with `Canonical mutation cancellation was not observed`, and then after the fix. Record both outputs.
2. **Mutants**, each red with its case. These are the reds for #1 and #4: their new cases need the new signature, so the old code cannot run them meaningfully.
   - (a) #2's wrapper back to one bound for every method → the delayed-probe case;
   - (b) #1's `runGate` back to a bare `spawnSync` with `timeout: 5000`, keeping `hangGitHub` → the hang case shows `status: null` and no phase;
   - (c) #4's `awaited` ignored → the 100 ms-window case.
3. **Static checks.** The three files green alone; `pnpm lint`, `pnpm typecheck`, `pnpm check`.
4. **Five loaded runs** of the full `pnpm test:integration`. Load is generated as in #656 slice 2: bounded `yes` generators, with the 1-minute load ≥ 13 at each start and < 67. For each run record the load before and after, the result, and the induced cases' `waitedMs` and `closedMs`. One unloaded run of `instance-lifecycle.integration.test.ts` records the same two values. Any failure in the three files stops the slice and is reported.
5. **Trusted VPS.** Exact-head `pnpm test:docker` + `pnpm test:deploy`.

## Limits

- **`max-lines`.** All three test files are far under 800.
- **Out of this slice:** `observeHttp`'s default (the secondary table's #11), `eventually`'s other callers, and custody (#5–#8).
- **The loaded runs alone cannot prove the fix.** The unfixed code already passed five runs at load 15–50. The distinguishing proof is evidence items 1–2.
