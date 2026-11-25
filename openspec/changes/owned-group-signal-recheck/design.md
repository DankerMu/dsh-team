# Design

**Change surface:** `signalOwnedGroup` in `scripts/trusted-docker-owner.mjs`, called only through `ownedCancellation` (the cancellation watcher in `runTrustedDockerOwner`).

**Must preserve:**

- A live, identity-bound group is signalled and `true` is returned (`trusted-docker-retirement.integration.test.ts`, "reports the group signal it actually sent").
- A child that ended before the call resolves `false` with no `process.kill` (existing `it.each`).
- Identity-changed paths throw the existing messages.
- `trusted-docker-cancellation.integration.test.ts` stays green unchanged.

**Must change (race window only):** when the child ends during the final `ownerIsLive`:

- `signalOwnedGroup` resolves `false`, not ESRCH or `true`;
- `ownedCancellation.signalled` stays `false`, so `retirement.json` is not written;
- the attempt is neither throttled nor traced as a failure;
- the terminal `failure` is not set to `'identity'`;
- `interruption` keeps its first kind.

**Governing invariant:** custody sends a group signal only when, at the synchronous instant before `process.kill`, its own child handle still reports no exit and no signal and the identity checks have passed.

**Sibling surfaces:**

- The entry check and the post-`ps` check in the same function already follow the invariant.
- `externalSignal` in `scripts/probe-browser-native.mjs:208-212` uses the same `await processBirth` → `process.kill` shape. It is a non-goal: the target is not a child of this process, so no synchronous exit state exists to re-read, and the birth check is the only available guard. It is recorded as out of scope, not fixed.
- `groupIsAbsent` in `scripts/trusted-docker-record.mjs:162-171`: none. It sends only signal 0.

**Seams under test:** the exported `signalOwnedGroup`, with a real detached child. Only the second `ownerIsLive` call (`:167`) is intercepted; the first uses the real implementation.

**Required evidence:**

- **Red (fix reverted):** `signalOwnedGroup` resolves `true`, and the stubbed spy records `(-pid, 'SIGINT')`.
- **Green:** it resolves `false`, and the spy saw no negative-pid call.
- The spy stubs negative-pid calls, so even the red run never sends a real SIGINT to a reaped group number.

**Non-goals:** `externalSignal`; any change to identity rules, `ownerIsLive`, or the cancellation watcher.

**Review focus:**

- No `await` sits between the recheck and `process.kill`.
- The mock is scoped and does not leak into other cases.
- The race-window state transitions listed above hold.
