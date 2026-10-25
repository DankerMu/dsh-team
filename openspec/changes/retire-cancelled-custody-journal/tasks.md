## Risk packs

- Auth / permissions / secrets — **selected**: deletion authority comes only from the private journal's exact names and labels (1.2, 2.2, 2.3).
- Concurrency / shared state / ordering — **selected**: settle, then recheck digest, then mutate; reverse run order; platform drain before any removal; host-wide deployment lock (1.1, 1.3, 1.4, 2.4–2.7).
- Error handling / rollback / partial outputs — **selected**: failures are recorded without throwing; the cancelled result stays failed; uncertainty stays `unconfirmed` (1.5, 2.1, 2.5).
- File IO / path safety — **selected**: journal file authority checks are reused; the lock file is never unlinked (1.2, 2.6).
- Documentation — **selected**: spec MODIFIED requirement; `AGENTS.md` custody and deployment paragraphs (3.1).
- Public API / CLI — not selected: `verify:docker` arguments and outputs are unchanged.
- Config, Schema, Resource limits (journal bound reused), Legacy, Release — not selected.

## 1. Implementation

- [ ] 1.1 `scripts/trusted-docker-owner.mjs`: after the existing settlement and `await cancellation`, and before `assessTrustedDockerCleanup`, call one retirement step. Phase A preconditions: `signalled`; `command.settled && producerCleanupConfirmed`; process writers dead and container writers absent except a run's own exactly bound `dsh-team-platform`; and a **new** `readInvocation` digest check, made immediately before mutation, still matches. Phase B (after the platform drain, before any `rm` of that run): `readVerificationSubmissionsForCleanup` succeeds. The existing post-assessment digest check stays.
- [ ] 1.2 The journal is read with the same lstat authority check as the audit, then `readCleanupJournal`. Phase A writer liveness uses one pending-tolerant extension of the existing `readVerificationSubmissionsForCleanup`/`readContainerWriters` chain, plus the audit's absence observation, not copies:
  - the exempt current platform generation requires initialization plus a binding witness;
  - every other generation is checked at completion level;
  - a bound-but-uncompleted process writer, or a reserved generation without `.binding.json`, counts as live.
- [ ] 1.3 Extract `drainDeployment`'s logic from `platform/test/deployment-fixture.ts:166-195` into one helper in `platform/test/docker-cleanup.ts`, parameterised by an async Docker command and runId. Behaviour is identical:
  - absent → none;
  - name or label mismatch → refuse;
  - `created` → no signal;
  - running → SIGTERM, `wait` must print `0`, then `Running:false`, `ExitCode:0`, `OOMKilled:false`.

  `deployment-fixture.ts` calls it. Do the same for the `flock --nonblock /tmp/dsh-team-deployment.lock` holder (`deployment-fixture.ts:228-260`): extract one helper that both use, keeping stdin-EOF release and no unlink.

- [ ] 1.4 Journal retirement in `docker-cleanup.ts`:
  - group by runId and process runs in reverse first-appearance order;
  - a run whose entries include container `dsh-team-platform` with its own ownership: lock (non-blocking), then drain, then phase B settlement, then `cleanupTargets`, then release. If the lock is unavailable, the drain fails or phase B fails, record a failure and remove nothing of that run;
  - other runs: `cleanupTargets` as today.
- [ ] 1.5 Result invariants: `state` stays `failed`; `command`, `interruption` and `failure` are unchanged. Uninterrupted runs never call retirement. The owner never writes submission records (see design, item 7).

## 2. Tests (RED first)

- [ ] 2.1 Integration through `withTrustedDockerFixture`, using an owner-only preload (pattern at `trusted-docker-fixture.ts:101-119`). The preload intercepts every `docker` spawn or spawnSync, and `flock` where needed, against a fixture-owned fake daemon state file that the fixture child writes when it registers its targets through the real `registerCleanupTarget`.
  - The child registers a running `dsh-team-platform` (own run label), one employee container, one network and one volume. It binds the fake platform as a container-kind observer writer through the real path: the parent calls `bindVerificationDockerObserver`, and a fixture process calls `claimVerificationDockerObserver(bootstrap, authority)` and then `initialize()`, and calls `finish()` only when the fake daemon processes the SIGTERM. Hand-written `completed` records are not acceptable. It then blocks before its cleanup. The operator cancels.
  - RED: all remain, and `unconfirmed`.
  - GREEN: platform `kill --signal SIGTERM` happens before any employee `rm`; all are absent; `confirmed`, `state: failed`, `signal: SIGINT`, `interruption: cancelled`.
  - Assert that no real docker process was started. Record the RED output.
- [ ] 2.2 In the same fixture: an unregistered `dsh-team-` sentinel with the same prefix, and a registered name whose fake labels mismatch, both survive.
- [ ] 2.3 Zero mutating calls and `unconfirmed` for each of: a live process writer; a live non-exempt container writer; an unsettled same-group member (reuse the existing unsettled-group pattern); a changed manifest digest.
- [ ] 2.3a The platform exits 0 after SIGTERM, but its reservation stays unsettled → `kill` issued, no `rm` for that run, `unconfirmed`.
- [ ] 2.3b A reserved, unbound pending generation (no `.binding.json`) → zero mutating calls, `unconfirmed`.
- [ ] 2.4 Drain unit tests with an injected command:
  - `created` → no kill, then removed;
  - exit nonzero → none of the run removed;
  - `OOMKilled:true` → none of the run removed;
  - label mismatch → refusal;
  - absent → no-op.
- [ ] 2.5 A non-platform registered container that ignores SIGTERM is still retired via `cleanupTargets`.
- [ ] 2.6 Lock unavailable → zero mutating calls for that run, `unconfirmed`; the lock path is never unlinked.
- [ ] 2.7 Reverse order: run A registers `dsh-team-platform` under `foreign-A`, and later run B registers the real one. B is drained and removed first, A's entry sees absence, and no failure is recorded.
- [ ] 2.8 Existing suites are unchanged and passing:
  - `trusted-docker-custody`, `trusted-docker-audit` and `trusted-docker-output` integration;
  - `deployment-setup-lifecycle` integration (lock/drain extraction);
  - `docker-cleanup` tests.

## 3. Docs and verification

- [ ] 3.1 Update `AGENTS.md` in two places: the Trusted Docker verification paragraph (the "The original root command retains cleanup mutation ownership…" sentence) and the Compose deployment verification lock and drain paragraph. They must describe the post-cancellation journal retirement, the platform drain under the lock, and every prohibition, which all stay unchanged.
- [ ] 3.2 `pnpm check:fast`, `pnpm lint:tests`, `pnpm dead-code`, `pnpm duplicate-code`, `pnpm lint:agents`, plus the suites in 2.8.
- [ ] 3.3 Parent (giap-vps):
  - Run the exact-head full `pnpm test:docker` and `pnpm test:deploy`.
  - Cancellation qualification:
    1. Capture `host-before`.
    2. Start custody on the reviewed head.
    3. Cancel only once all of the following hold: the journal contains this deployment run's `dsh-team-platform` registration; its observer binding is published (`<nonce>.approval.json` or `.binding.json`); and a read-only inspect shows that platform and at least one `dsh-team-u-*` with the same run's labels running.
    4. Expect `cleanup.state: confirmed` and `state: failed`. An independent observation must show `registeredPresent: []`, empty owned inventory, unchanged daemon/docker0/foreign containers, and `/tmp/dsh-team-deployment.lock` still present.
    5. If retirement fails, fall back to manual exact-identity recovery and report it.

## Non-goals

- Model-lane finalizer changes (observation only).
- Recovery after unknown owner death.
- In-band graceful abort.
- Discovery- or prefix-based cleanup.
