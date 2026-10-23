## Design

Change surface: `platform/test/ci-vps-worker.ts` (`command()`, `execute()`, `executeAndRecord()`), its private invocation directory `~/.local/share/dsh-team/ci/<invocation>/`.

Must preserve:

- One-shot admission, approval validation, expiry/cancel handling, cgroup/unit retirement, `finalize`/`finalize-locked`/`watch`/`await*` modes and their deadlines.
- `final.json` shape `{vpsCleanupComplete, failures, exitCode}` and `scripts/ci-vps-owner.mjs` host-receipt parsing; old receipts without phase facts remain valid.
- `execution.json` keeps `exitCode` (0..255 integer) exactly as today; execution failure is never rewritten by cleanup success and cleanup failure is never hidden by execution success.
- Driver credential handling: `DMXAPI_KEY` loaded only inside the driver child and redacted from `execution.log`; proxy values never forwarded to git/pnpm.
- Module closure: the implementation stays inside `platform/test/ci-vps-worker.ts` (or any new module it imports is added to the trusted archive list in `scripts/ci-vps-owner.mjs`), so the VPS worker cannot fail at import and consume an authorization without evidence.
- Write order: `execution.log` (driver only) precedes `execution.json`, and `execution.json` stays the last write of `execute`, because `watch()` starts finalization as soon as it exists.

Must add/change:

- The admission `phase.json` is written only after `approval()` has validated the invocation directory and approval file; an invalid approval writes no phase receipt (the existing `execution.json` `{exitCode:1}` from `executeAndRecord` is unchanged).
- `phase.json` (0600, atomic via existing `writeReceipt`): `{version:1, phase, state:'entered'|'completed'|'failed', category?, exitCode?, signal?}` published before a phase starts and updated when it ends. Phases: `admission`, `checkout` (git init/remote/fetch/checkout/identity), `install`, `build`, `driver`.
- `execution.json` gains optional `phase` and `category` from the same closed sets; consumers ignore them when absent.
- Remove the existing raw pass-through of preparation stdout from `command()` to the worker's stdout (systemd journal); preparation output is discarded, never logged.
- `performFinalization()` validates `execution.json` (private 0600 regular file, <=16KiB, `exitCode` safe integer 0..255); missing, malformed, oversized or out-of-range values fail closed to `exitCode: 1`. `final.json` keeps exactly `{vpsCleanupComplete, failures, exitCode}` with no phase fields.
- Phase and category values are written only from fixed in-code sets.
- Category derivation from the spawn result only: `error.code === 'ETIMEDOUT'` → timeout; `ENOBUFS` → output-limit; other `error` → spawn-error; `signal` → signal; nonzero status → nonzero; checkout SHA mismatch → identity-mismatch; admission expiry/cancel or "Execution already retiring" → admission-expired; nonzero/failed `git rev-parse` → checkout/category from its spawn result; anything else → unknown.

Governing invariant: retained worker evidence states which phase was last entered and how it ended using only closed-set fields, and never contains raw output, arguments, environment, error text or secret values.

Sibling surfaces: `execution.log` (driver only, existing redaction unchanged); `final.json` producer `performFinalization()`; owner `hostReceipt()`/`parseHostReceipt()` (must keep accepting new and old receipts); `browser-build-fixture.ts` / `ci-vps-owner-fixture.ts` which drive the real worker; AGENTS.md model-lane documentation.

Seams under test: the real worker entry (`node --import <preload> platform/test/ci-vps-worker.ts execute|finalize-locked <invocation>`) as `browser-build-fixture.ts` does. Setup: HOME = fixture root; 0700 invocation dir `~/.local/share/dsh-team/ci/<id>/` with 0600 `approval.json` and `admitted.json`; fake `git`/`pnpm` under `$HOME/.local/share/dsh-team/toolchain/pnpm-10.34.6/node_modules/.bin` (the preload redirects `git` explicitly so the test never depends on PATH resolution order; `systemctl` is redirected to a fake answering `LoadState=not-found`, as `browser-build-fixture.ts` does, so finalization can complete); `$HOME/.config/dsh-team/env` present (driver `loadEnvFile` requires it). The preload only sets `process.platform` to linux and redirects binaries (to fakes, to an absent path for spawn-error, and shortens only the test's spawn timeout for the timeout case). The driver child does not inherit `--import`; its `pnpm` resolves through the HOME toolchain PATH.

Required evidence:

- checkout failure (fake git exit 1) → `phase.json` `{phase:'checkout', state:'failed', category:'nonzero', exitCode:1}`, `execution.json.exitCode === 1`, `phase:'checkout'`.
- install failure (fake pnpm install exit 7) → `{phase:'install', state:'failed', category:'nonzero', exitCode:7}`.
- build killed by SIGKILL from the fake itself → `{phase:'build', state:'failed', category:'signal', signal:'SIGKILL'}`.
- Field rule: `exitCode` is present only when spawnSync reports a non-null status; `signal` only when it reports a non-null signal; nothing else from the spawn result is kept.
- build exceeding a preload-shortened test timeout (spawnSync: `error.code ETIMEDOUT`, status null, signal SIGTERM) → deep-equal `{version:1, phase:'build', state:'failed', category:'timeout', signal:'SIGTERM'}`; production deadline values unchanged.
- build writing >16MiB stdout (spawnSync: `error.code ENOBUFS`, status null, signal SIGTERM) → deep-equal `{version:1, phase:'build', state:'failed', category:'output-limit', signal:'SIGTERM'}`.
- git redirected to an absent path (spawnSync: `error.code ENOENT`, status null, signal null) → deep-equal `{version:1, phase:'checkout', state:'failed', category:'spawn-error'}` with no `exitCode`/`signal`.
- fake `git rev-parse` exiting 0 with a different 40-hex → deep-equal `{version:1, phase:'checkout', state:'failed', category:'identity-mismatch', exitCode:0}` (field rule applies literally).
- `approval.json` with past `expiresAt` and no `admitted.json` → `{phase:'admission', state:'failed', category:'admission-expired'}`, execution exitCode 1.
- `admitted.json` plus `cancel` present → `{version:1, phase:'admission', state:'failed', category:'admission-expired'}`, execution exitCode 1.
- interrupted phase: fake `pnpm build` blocks; the worker is spawned detached and its whole process group is SIGKILLed (no fake may survive; assert absence) → `phase.json` exactly `{version:1, phase:'build', state:'entered'}`, no `execution.json`.
- every prep failure: `execution.json` `{exitCode:1, phase, category}` and no `execution.log`.
- driver: fake `pnpm test:model` exit 0 → `{phase:'driver', state:'completed'}`, exitCode 0; exit 3 → driver/failed/nonzero, exitCode 3.
- finalize: real execute failure then `finalize-locked` → `final.json` deep-equals `{vpsCleanupComplete:true, failures:[], exitCode:1}` (no extra keys) and the real `final.json` bytes are accepted by the owner through the existing `ci-vps-owner-fixture.ts` fake-ssh receipt path (the owner's validator stays module-private); same for success with exitCode 0; malformed/oversized/out-of-range `execution.json` → finalization records exitCode 1.
- success path → `phase:'driver', state:'completed'`, exitCode from driver.
- Canary placements: random 40-hex `approved.sha` (appears in git fetch arguments); fake stdout/stderr; the absent spawn path (thrown error text); `HTTP_PROXY`/`HTTPS_PROXY` in the worker's environment; a canary `DMXAPI_KEY` in the env file echoed by fake `pnpm test:model`. Expect: no canary in `phase.json`, `execution.json`, `final.json`, or the worker's own stdout/stderr; proxy canary absent from the environment recorded by fake git/pnpm; `execution.log` contains `[REDACTED]` and not the key.
- Receipt files are 0600 regular files; owner `hostReceipt` still accepts `final.json`.
- Each failure-attribution scenario is RED against the pre-change worker and GREEN after.

Non-goals: retrying, extending deadlines, widening environment allowlists, forwarding proxies to git/pnpm, reading or printing credentials, changing host/daemon/services, attributing the historical `cce7783b…` failure, running the provider or the model workflow.

Review focus: secret/output exclusion on every failure path; phase published before work starts (crash mid-phase still leaves the entered phase); owner/finalizer compatibility; closed-set enforcement; no behavior change to admission/cleanup.
