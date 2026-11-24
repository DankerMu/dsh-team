# Custody fixture: a zombie group's EPERM is "still retiring"

## Why

Issue #690. Line numbers refer to main `139a261`; the issue cited `5102bbe`.

- **The fixture's group settle tolerates only ESRCH.**
  - `settle` in `platform/test/trusted-docker-fixture.ts:462-499` sends the group signal at `:493-497`, and rethrows anything but ESRCH.
  - Its absence wait (`:469-480`) calls `groupIsAbsent(pid)` (`scripts/trusted-docker-record.mjs:162-171`), which also treats only ESRCH as absence and throws EPERM.
  - The comment at `:473-474` already says a group "may return EPERM until the actual close event".
- **On Darwin, a group whose remaining members are unreaped orphan zombies answers `kill(-pgid, …)` with EPERM.**
  - The product code handles this: `groupSettlesAfterClose` (`trusted-docker-record.mjs:176-198`) treats EPERM as "observe again" within a bounded window, and rethrows a final EPERM.
- **Two terminal assertions have the same gap.** Each asserts `groupIsAbsent(pids.command)` once, which throws on a zombie group:
  - `trusted-docker-custody.integration.test.ts:709`;
  - `trusted-docker-uncaptured-fixture.integration.test.ts:67`. This one runs before its `AggregateError` assertion (`:70-73`), so a bare EPERM there would hide the attributed error.
- **Seen once:** a loaded local `pnpm check` (1-minute load about 80) failed the case at `:679` with a bare `kill EPERM`, and seven reruns passed. The failure path is inferred, not reproduced. So the regression case injects EPERM rather than relying on the race.

## What Changes

- **Group signal.** In `settle`, when `group` is true, `kill(-pid, signal)` treats EPERM like ESRCH: the group is retiring, and the wait continues. That EPERM becomes the wait's initial `denied`. The single-process kill still tolerates only ESRCH, and the group kill rethrows any other code.
- **Absence wait.**
  - The group probe in `waitForAbsence` treats EPERM as present, and keeps polling inside the existing `budget.limit('process retirement', 5000)`.
  - Any other error code still throws at once.
  - At expiry, the existing `budget.stalled('Owned custody fixture process did not retire', …, group)` error is thrown. When the last group EPERM was seen (from the kill or a probe), it is the error's `cause`. The failure therefore names the phase and pid and keeps the EPERM, never a bare `kill EPERM`.
  - **How the cause is attached:** `caseBudget`'s `stalled` (`trusted-docker-fixture.ts:164-167`) gains an optional last parameter `cause`, passed to `new Error(message, { cause })`. Its other callers (`main-startup-fixture.ts:154`, `chrome-start.integration.test.ts:84`) are unchanged.
  - **Which path reaches the stalled error:** the full 5 s window. Cleanup reserves its bounds (`:742`). Under a case deadline the wait's own `live()` observation (`budget.run('process observation')`, `:438`) usually hits the deadline first, and reports the budget's own error, which is also attributed.
  - This is fixture-local, with the same semantics as `groupSettlesAfterClose`: EPERM is "observe again", and the last EPERM is kept. As there, `denied` is reset on each probe that does not return EPERM. The product function is not changed. Reusing it would bring a 2 s `performance.now()` window that does not follow the case budget (the issue's alternative, not chosen).
- **Terminal assertions** (custody `:709` and uncaptured `:67`).
  - Each awaits the product's `groupSettlesAfterClose(pids.command)`, already exported. It settles a zombie group within 2 s, or rethrows its final EPERM, and it returns false for a live non-zombie group, so `toBe(true)` still fails there.
  - Imports: custody's `groupIsAbsent` import becomes `groupSettlesAfterClose`. Uncaptured adds `groupSettlesAfterClose` beside `groupIsAbsent`, which `:58` still uses.
  - In uncaptured, the terminal process checks (`:67-69`) move after the `AggregateError` assertion (`:70-73`), so the attributed error is asserted first.
  - At custody `:709` this is defensive: `:705` has already required the owner gone.
- **Deterministic regression cases** in `platform/test/trusted-docker-fixture.integration.test.ts`. They need `fixtureProcessCustody` to be reachable from that test, so it is exported, used only by the fixture and its test. Each case tracks one real detached `node` group, and `vi.spyOn(process, 'kill')` injects EPERM in the test process. The existing `fixture-preload.mjs` seam acts only inside the owner process.
  - **(a) Group kill EPERM.** The first `kill(-pid, 'SIGKILL')` really kills the group, then throws EPERM. `settle(identity, true)` resolves once the group is gone. Before the fix it rejects with `kill EPERM`.
  - **(b) Group probe EPERM, transient.** The first N `kill(-pid, 0)` calls throw EPERM, then the real call runs. `settle` resolves inside the budget. Before the fix it rejects with EPERM.
  - **(c) Group probe EPERM, persistent.** The budget is `caseBudget()` with no deadline, so the 5 s literal window is the only exit. The case's own vitest budget is stated (proposed 15 s). `settle` rejects with the stalled message (phase, `pid=`, `group present=true`) and the EPERM as `cause`.
  - **(d) Single-process kill EPERM.** `settle(identity, false)` with `kill(pid, 'SIGKILL')` throwing EPERM still rejects with that EPERM.
  - **(e) Another code (EINVAL) from the group probe** still rejects at once.
  - **(f) The group kill throws EINVAL**, and `settle(identity, true)` rejects at once with it.
  - **Spy rules.**
    - The spy matches the exact pid sign and signal, and passes every other call through to the real `process.kill`.
    - It is restored in `finally`, before the case's real cleanup retires the tracked group.
    - `ownerPresent(-pid)` inside `stalled` (`:166`) also goes through the spy. (b)'s EPERM count and (c)'s `group present=true` account for it.

Unchanged: `scripts/trusted-docker-record.mjs`, `scripts/trusted-docker-owner.mjs`, the owner-side `fixture-preload.mjs` EPERM modes, #687's custody rows, #692.

## Triage

```text
Issue type: test
Fixture level: standard
Upstream suggested level: absent
Blast radius: the custody fixture's process retirement; a too-broad EPERM tolerance would wait out the budget on a real permission error (bounded, attributed), and must never apply to the single-process kill
Selected risk packs: Concurrency / shared state / ordering (process-group retirement on Darwin); Error handling / rollback / partial outputs (the expiry keeps the EPERM as cause, other codes still throw)
Evidence floor: cases (a)–(b) red before the fix and green after; (c)–(f) green, and red under mutants (EPERM tolerated for the single-process kill; any code tolerated in the probe; any code tolerated by the group kill; cause dropped); trusted-docker fixture, custody, retirement and uncaptured integration files green; pnpm check; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `trusted-docker-verification`: the custody fixture's group retirement treats a Darwin zombie group's EPERM as still retiring, within its budget.

## Impact

`platform/test/trusted-docker-fixture.ts` (`settle`, `stalled`'s optional cause, the `fixtureProcessCustody` export), `platform/test/trusted-docker-fixture.integration.test.ts`, `platform/test/trusted-docker-custody.integration.test.ts` (`:709` and its import), `platform/test/trusted-docker-uncaptured-fixture.integration.test.ts` (`:67` and its import).

## Acceptance-criteria mapping (#690)

- `settle(identity, true)` with an EPERM group kill does not throw and enters the wait: (a). At expiry, the stalled error with pid and phase, the EPERM as cause: (c).
- The absence wait tolerates EPERM as present, and other codes still throw: (b), (e).
- `:709` (and its sibling, uncaptured `:67`) does not throw EPERM on a zombie group: `groupSettlesAfterClose`.
- A deterministic regression case, red before and green after; the single-process EPERM still throws: (a), (b), (d); the group kill's other codes still throw: (f).
- `pnpm test:integration` passes: task 2.1.
