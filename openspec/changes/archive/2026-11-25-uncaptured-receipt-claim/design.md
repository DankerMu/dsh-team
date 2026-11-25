# Design

**Change surface.**

- `boundCommand` and its caller `claimUncaptured` in `platform/test/trusted-docker-uncaptured-fixture.ts`.
- The uncaptured branch of `cleanupTrustedDockerFixture` in `platform/test/trusted-docker-fixture.ts:449-466`: whether to report and whether to retain.
- The owner and start preload in `trusted-docker-fixture.ts:180-220`: a start-delay hook and a late-finish owner variant.
- The first case of `trusted-docker-uncaptured-fixture.integration.test.ts`.

**Governing invariant.** This applies to the uncaptured claim. Its temporary root is deleted, and its authority handed back, only after the command's process group has been observed absent. Either cleanup settles it from a receipt or scan, or the owner's own `result.json` records `command.settled === true`. `groupSettlesAfterClose` sets that flag only on ESRCH for `kill(-pid, 0)` after the child's `close` (`scripts/trusted-docker-owner.mjs:347-360`, `trusted-docker-record.mjs:182-198`). Later steps can only lower it (`&&=`). An empty group cannot be re-entered.

**Why `settled` suffices without `child.json`.** The three paths that end without a receipt:

- **Cancel or control failure before spawn.** Nothing was spawned.
- **Spawn `ENOENT`.** `close` fires with pid `undefined`, and `groupIsAbsent(undefined)` is true. This was checked on Node 24.13.1.
- **Identity-write failure (`:382-384`).** The owner still awaits `finished`.

In all three, `settled` true means no live group.

**Ordering in `boundCommand`.**

1. Owner alive → freeze → receipt or scan, unchanged.
2. Owner gone → `child.json` receipt first, unchanged.
3. Otherwise, the new step: read `result.json` and `manifest.json` with `readCustodyRecord`, which requires mode 0600. Then call `validateTerminal(value, invocation, manifestDigest)`, all exported from `scripts/trusted-docker-record.mjs`. The invocation id comes from `launch.json`'s `invocation`. The new step requires it to be a string matching `INVOCATION_PATTERN`; otherwise the step is retained via `UnidentifiedCommand`. The stub's `launch.json` gains the field. `readInvocation` is not used, because its `custodyPaths` reads the test process's `HOME`.
   - If the record validates and `command.settled === true`, return a distinct `finished` outcome.
   - If it is missing, unreadable, invalid or unsettled, throw `UnidentifiedCommand('owner gone without receipt')` exactly as today.

**Distinct outcome.** `finished` reports `command finished`. The fixture's uncaptured branch (`:462,466`) currently pushes `Uncaptured custody fixture authority retained: <report>` for every uncaptured name. It must skip that failure only for `finished`. The frozen-owner, zero-children `no command started` and every existing report stay exactly as they are.

**Sibling surfaces.** `captureStart`'s in-wait `result.json` exit (`trusted-docker-fixture.ts:570-583`, then `:476-487`) deletes the root without checking `settled`. It is a preserved, unchanged path and is outside this invariant.

**Must preserve.**

- All scenarios of the two modified requirements, including "Identification is uncertain" and the late-`child.json` receipt.
- These stub rows of `trusted-docker-uncaptured-fixture.integration.test.ts`, with unchanged outcomes:
  - `gone, no receipt` (`:384`);
  - `gone at its stop` (`:385`);
  - `gone, unsettled` (`:428`).
- The exact error lists at `trusted-docker-uncaptured-fixture.integration.test.ts:70-73` and `:166-181`, and at `trusted-docker-deadline.integration.test.ts:169-172`.
- `captureStart`'s `result.json` exit inside the identity wait (`trusted-docker-fixture.ts:570-583`).
- No change to `scripts/`.

**Seams under test.**

- **Stub level.** `claim(stub)` gains `result` and `manifest` options, written at mode `0o600` as complete terminal records. Rows:
  - settled → `command finished`, authority handed back, `settle` events;
  - unsettled, differing only in `command.settled` → retained, today's exact row;
  - settled with a wrong `manifestDigest`, and settled with a wrong `invocation` → retained;
  - unreadable `result.json` (mode 0644) → retained;
  - missing `manifest.json` → retained (a missing `result.json` is the existing row `gone, no receipt`);
  - `launch.json` without `invocation` → retained;
  - both `child.json` and settled `result.json` → `command 7`, the receipt wins.
- **Real owner.**
  - Mechanism: the owner preload holds the `pnpm test:docker` spawn until a release file appears, then spawns a nonexistent binary. That gives `failure: 'launch'`, no `child.json`, and `settled: true`.
  - The case waits for `result.json` and for the owner's absence before cleanup. Otherwise a live owner would go through freeze → scan → `none` and pass for the wrong reason.
  - Its budget is derived as in `:93-101`.
  - An **unreleased** row of the same late-finish mode keeps the owner alive. It goes freeze → scan → `none` and must still report `…retained: no command started`. This pins that the retained-failure skip keys on `finished` itself.
  - Assert that the owner's `request.temporary` (`/tmp/dsh-team-docker-XXXXXX`) is deleted, and that the case's errors contain only its own failure.
- **Start delay.**
  - It goes in the preload's wrapper around the `own` spawn (`trusted-docker-fixture.ts:194-197`). That runs inside node `start`, after `request.json` and before `launch.json` (`owner.mjs:137`).
  - It is gated by a test-only variable, e.g. `DSH_TEAM_FIXTURE_START_DELAY_MS` (outside the `PLATFORM_*`/`DOCUMENT_SERVER_*` inventory prefixes), passed through `fixture.start(extraEnvironment)`. The owner's `runtimeEnvironment` filters it out.
  - The delay exceeds the 2.5 s start slice.
  - The first case runs as `it.each` over no delay and delayed, so the hook is live code.
  - `COMMAND_LAUNCH_MS` and the 20 s case bound are re-derived to cover the delay.
  - On main, the delayed row fails with `ENOENT … launch.json`. The red run leaks the owner and the held leaf, so take their pids from `ps` (match `trusted-docker-run.mjs own` and `fixture-child.mjs` under that fixture repository path, since the case's `finally` removes `launch.json`) and kill them by hand.

**Leak measurement (#2).**

- Before and after one green full `pnpm test:integration`, with no other vitest or integration run on the machine, diff the name lists, not counts, of:
  - owner roots `/tmp/dsh-team-docker-??????` (six characters, no dash; this excludes `-custody-`, `-config-` and `-evidence-`);
  - `$TMPDIR/dsh-team-custody-audit-*`.
- An empty diff meets the acceptance.
- A non-empty diff leaves #718 open with the attribution recorded. The PR uses `Refs`, and a follow-up is filed for a sweep decision.

**Non-goals.**

- No sweep or `globalSetup`.
- No change to the live owner that wrote `result.json` but no `child.json`, which still goes freeze → scan → `no command started`. That label is pre-existing and recorded only.
- No `scripts/` change.
