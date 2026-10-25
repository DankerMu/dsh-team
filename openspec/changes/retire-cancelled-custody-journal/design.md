Change surface:

- `scripts/trusted-docker-owner.mjs` (`executeOwnedCommand`): one retirement step between settlement and `assessTrustedDockerCleanup`.
- `platform/test/docker-cleanup.ts`: the platform drain, extracted from `deployment-fixture.ts` `drainDeployment`, plus run-ordered journal retirement.
- `platform/test/deployment-fixture.ts`: calls the extracted drain and lock helpers instead of its own copies.
- A small shared host-lock helper, extracted from `deployment-fixture.ts:228-260`.
- Spec `trusted-docker-verification`.
- `AGENTS.md` Trusted Docker verification (line ~263) and Compose deployment verification (lines ~239-245) paragraphs.

Must preserve:

- Cancellation authority checks: `readCancellation`, and `signalOwnedGroup`'s identity and group verification. SIGINT goes to the verified group only.
- The terminal record. `state` stays `failed` for any interruption, and `hasPassingOutcome` (`scripts/trusted-docker-record.mjs:275-284`) still requires `interruption==='none'`. `command`, `interruption` and `failure` keep their semantics.
- `assessTrustedDockerCleanup` stays read-only and is the sole source of `cleanup.state`/`browserExec`. The existing post-assessment `readInvocation` digest check stays.
- Uninterrupted runs: no owner retirement.
- Model-lane finalizer: unchanged.
- `cleanupTargets`/`removeOwned` label, name and network checks: unchanged.
- `readCleanupJournal` bounds and grammar: unchanged.
- Deployment fixture normal-path behavior, including its drain conditions (`created` platform not signalled; exit 0 and not OOM required), lock semantics (`flock --nonblock`, stdin-EOF release, never unlinked) and setup-evidence phases.

Must add:

1. **Preconditions, phase A (before any mutation).** Retirement starts iff all of the following hold. Otherwise nothing is mutated and the assessment yields `unconfirmed`.
   - `signalled === true`;
   - `command.settled && producerCleanupConfirmed`;
   - browser producers have settled;
   - every recorded process-kind submission writer is dead, and every container-kind writer is absent **except** a run's own registered `dsh-team-platform` whose exact bound container ID matches that writer. A running deployment platform is itself a container-kind observer writer (`deployment-observer-fixture.ts:223-237`) and can only settle after its drain. The writer list comes from `readVerificationSubmissionsForCleanup` → `readVerificationDockerObserverWriters` → `readContainerWriters`, which demands completion for every generation and therefore throws while the platform lives. Phase A thus needs one pending-tolerant reader (extending that chain, not a copy). It requires the exempted current platform generation to pass `requireObserverInitialization` plus its binding witness, and every other generation to pass completion-level checks. A bound-but-uncompleted process writer, and a reserved generation without `.binding.json`, are non-exempt live writers;
   - a **new** `readInvocation` digest check, made immediately before any mutation, still matches.

   **Phase B (after a successful platform drain, before any `rm` of that run).** `readVerificationSubmissionsForCleanup` must succeed, meaning every reservation has settled and no pending marker remains, and the drained platform writer must now be exited. If phase B fails, nothing of that run is removed and a failure is recorded.

2. **Journal authority.** The same lstat checks as the audit (regular file, current uid, no group/other bits), then `readCleanupJournal`.
3. **Run order.** Group entries by `runId` and process runs in **reverse first-appearance order**. A later run may own a name that an earlier run registered as a foreign sentinel (e.g. `dsh-team-platform` under `foreign-<run>`); the later owner retires it first, so the earlier entry then sees exact absence.
4. **Platform drain.** A run whose entries include container `dsh-team-platform` with that run's own ownership is handled as follows:
   - Take the host-wide deployment lock non-blocking through the extracted helper (same `flock --nonblock /tmp/dsh-team-deployment.lock` holder, never unlinked, released by stdin EOF). If the lock is unavailable, skip this run.
   - Under the lock, run the extracted platform drain:
     - absent → nothing to drain;
     - label or name mismatch → refuse;
     - `created` → no signal;
     - running → `kill --signal SIGTERM <id>`, `wait <id>` must print `0`, then inspect must show `Running:false`, `ExitCode:0`, `OOMKilled:false`.
   - If the drain fails, nothing of that run is removed and a failure is recorded.
   - On drain success, run phase B. If phase B passes, call the existing `cleanupTargets` for that run while still holding the lock, then release the lock.
5. **Other runs.** Runs without a registered platform call the existing `cleanupTargets` (`rm --force` for containers). This matches the existing fixture `finally` behavior; their containers are not SIGTERM-drainable (`container-start-docker-fixture.ts:120-121` runs `sleep infinity`; the employee PID1 `dsh` has no init).
6. **Failures** are collected and never thrown out of the owner.
7. **Submission evidence (sibling requirement "Every shared-Engine producer has attributable submission evidence").** The owner's retirement creates nothing. It only signals or removes exact registered identities after every producer and writer has settled, and every removal is followed by the independent read-only exact-absence assessment. So it introduces no unattributed creation. It therefore does not write submission records and does not become a writer the assessment must wait on.

Governing invariant: the owner mutates only resources whose exact name and labels this invocation's private journal registered. It does so only after everything that could still create or use them has provably settled, and only under the deployment lock for a deployment run. Otherwise the result stays `unconfirmed`, and a cancelled run is never `passed`.

Sibling surfaces:

- `assessTrustedDockerCleanup`: read-only consumer, unchanged.
- `verify-browser-runtime.mjs` root cleanup: browser only, unchanged.
- Model-lane finalizer: forward-order force retirement without drain or lock. Out of scope; reported as an observation.
- `deployment-fixture.ts` drain and lock: now share the extracted helpers.
- `status`/`cancel` terminal reread: unchanged.

Seams under test:

- **Integration.** The real custody owner runs through `withTrustedDockerFixture`'s real pnpm/fixture-child boundary, with an **owner-only preload** that follows the existing pattern at `trusted-docker-fixture.ts:101-119` (wrap the `own` spawn with `--import`, `syncBuiltinESMExports`).
  - The preload intercepts every `child_process` spawn or spawnSync whose file is `docker`, and answers from a fixture-owned fake daemon state file that the fixture child also writes.
  - It also intercepts `flock` for the lock-unavailable case.
  - The test asserts that no real `docker` process is started. `pnpm test:integration` never touches an Engine.
- **Unit.** `docker-cleanup.ts` drain, lock decision and run-order logic, with an injected `DockerCommand`.

Required evidence (input → expected output):

- **RED, current code.** The fixture child registers a running `dsh-team-platform` (own run label), one employee container, a network and a volume. It binds the fake platform as a container-kind observer writer through the real `bindVerificationDockerObserver` path, leaving a pending reservation that settles only when the fake daemon processes the SIGTERM. It then blocks before its cleanup, and the operator cancels. Result: all remain, and `cleanup.state: unconfirmed`.
- **GREEN, same input.** The platform receives SIGTERM, exits 0 and is removed before any employee `rm`; everything registered is absent; `cleanup.state: confirmed`, `state: failed`, `signal: SIGINT`, `interruption: cancelled`.
- An unregistered `dsh-team-` sentinel with the same prefix, and a registered name whose live labels mismatch, both survive.
- A live process writer, a live non-exempt container writer, an unsettled same-group member, or a changed digest → zero mutating Docker calls, `unconfirmed`.
- The platform exits 0 after SIGTERM, but its observer reservation stays unsettled (pending marker) → no `rm` for that run, `unconfirmed`.
- Platform in `created` state → no `kill`, then removed.
- Platform exit code nonzero, or `OOMKilled:true` → nothing of that run removed, `unconfirmed`.
- A non-platform registered container that ignores SIGTERM is still retired by `cleanupTargets`.
- Deployment lock unavailable → zero mutating calls for that run, `unconfirmed`. The lock file is never unlinked.
- Reverse order: run A registers `dsh-team-platform` under `foreign-A`, and later run B registers the real one. B's container is drained and removed, A's entry then sees absence, and no failure is recorded.
- **giap-vps qualification:**
  1. Capture `host-before` (daemon PID, docker0, foreign containers).
  2. Start custody on the reviewed head.
  3. Cancel only once all of the following hold: the invocation journal contains this deployment run's `dsh-team-platform` registration; the run's observer binding has been published (`<nonce>.approval.json` or `.binding.json`, i.e. `bindDeploymentObservation` completed); and a read-only inspect shows the platform and at least one `dsh-team-u-*` with the same run's labels running.
  4. After cancel: `cleanup.state: confirmed`, `state: failed`, `registeredPresent: []`, empty owned inventory, daemon/docker0/foreign containers unchanged, and `/tmp/dsh-team-deployment.lock` still present.
  5. If retirement fails, fall back to the existing manual exact-identity recovery and report the failure.

Known limitation: if the cancellation kills a Vitest worker in the middle of a `beginVerificationSubmission` Docker call, that submission stays `submitted` forever. Phase A then passes, the platform is drained, and phase B fails, so nothing of that run is removed and the result is `unconfirmed`. Recovery is the manual exact-identity procedure (3.3 step 5); this change does not auto-resolve it.

Non-goals:

- Recovery after unknown owner death.
- In-band graceful abort.
- Model-lane changes.
- Prefix or label discovery cleanup.
- Changing test discovery, deadlines or assertions.

Review focus:

- Deletion authority: journal only, exact labels.
- Two-phase settlement: the exact platform writer is exempted before the drain; full submission settlement is required before any removal.
- Drain only the platform, under the lock, with a single drain implementation.
- A cancelled run never passes.
- No change for uninterrupted runs or the normal deployment path.
- No real Docker in integration tests.
