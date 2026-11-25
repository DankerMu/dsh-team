# Recheck the child's exit right before signalling its group

## Why

Issue #720. Line numbers refer to main `a4efa57`.

`signalOwnedGroup` (`scripts/trusted-docker-owner.mjs:153-171`) checks `child.exitCode`/`child.signalCode` at entry and again after the `ps -o pgid=` read, but the last `await ownerIsLive(identity)` (`:167`) is followed directly by `process.kill(-identity.pid, 'SIGINT')`. If the child exits and is reaped while that await is pending, its pid and process-group number can be reused; on Darwin `ownerIsLive` spawns an external process, which widens the window. The birth comparison inside `ownerIsLive` makes this unlikely, but the consequence is a SIGINT to an unrelated group.

## What Changes

- Re-read `child.exitCode` and `child.signalCode` synchronously after the last `ownerIsLive` and immediately before `process.kill`; when either is set, return `false` without signalling, as the entry and post-`ps` checks already do.
- One regression case: the child exits during the final `ownerIsLive`; `signalOwnedGroup` resolves `false` and `process.kill` is never called. Red against the current source, green after.

Behavior in the race window changes on purpose. Today a reaped child either makes `process.kill` throw ESRCH (`ownedCancellation.failed`, which becomes the terminal `failure ??= 'identity'` at `scripts/trusted-docker-owner.mjs:304`) or reaches leftover group members and returns `true` (driving `retireAfterCancellation`). After the fix both become a quiet `false`: the command already ended, so no signal was sent and none is claimed.

## Triage

```text
Issue type: bugfix
Fixture level: expanded (concurrency trigger)
Upstream suggested level: absent
Blast radius: trusted custody cancellation could SIGINT a foreign process group in a pid-reuse window
Selected risk packs: Concurrency / shared state / ordering (exit observed during an await before a signal); Error handling / rollback / partial outputs (race-window outcome moves from ESRCH failure or true to false)
Evidence floor: new case red before / green after; existing signalOwnedGroup and cancellation cases green; pnpm lint, typecheck; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `trusted-docker-verification`: the owner never signals a captured group whose command already ended while identity was being re-checked.

## Impact

- `scripts/trusted-docker-owner.mjs` (`signalOwnedGroup` only)
- one new integration test case under `platform/test/` (location chosen by the implementer; a module mock of `ownerIsLive` must not affect unrelated cases)
