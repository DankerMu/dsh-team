# Retire the uncaptured command group

## Why

Issue #661. All line numbers refer to main `e075cff`.

The custody fixture's cleanup has an uncaptured path for a start that was killed at the case deadline. On that path it SIGKILLs the owner first (`platform/test/trusted-docker-fixture.ts:765-773`) and then reads `child.json` (`uncapturedAuthority`, `:607-620`). The command group is retired only when `child.json` exists (`:779-781`).

The owner writes `child.json` only after a series of steps (`scripts/trusted-docker-owner.mjs:328-379`):

1. it spawns detached `pnpm test:docker` (`:329-340`), so the command leads its own group;
2. it waits for `spawn`;
3. it observes the command's birth (`:373`);
4. it writes `child.json` (`:374`).

If the owner is killed anywhere in that window, `child.json` never appears. The command group (pnpm plus the fixture leaf) is then orphaned. In the held modes it waits forever. The only report is the pid-less `Uncaptured custody fixture authority retained` (`:762`).

No case reaches this window. The existing deadline case (`trusted-docker-custody.integration.test.ts:679`) polls until `child.json` appears before it returns.

## What Changes

- **Freeze, bind, kill, settle.** On the uncaptured path, cleanup now runs these steps for each uncaptured name:
  1. Confirm the owner's identity (`live()` with its birth), then send SIGSTOP.
  2. Confirm the stop took effect, within a bound: `ps -o stat= -p <owner>` starts with `T`.
  3. While the owner is frozen, bind the command identity. It comes from `child.json` if that file exists. Otherwise it comes from an identity-bound scan of the owner's direct children, `ps -ww -A -o pid=,ppid=,pgid=,command=`, classified as follows:
     - **command:** `pgid == pid` and the command line runs `pnpm … test:docker`. `observeProcess` binds its birth.
     - **in flight:** the command line is identical to the owner's own. A fork that has not exec'd yet (Linux libuv fork → setsid → exec) looks like this. Rescan within a bound; if it persists, the authority is retained.
     - **ignored:** not detached (`pgid` equals the owner's pgid) and not in flight. Examples are the Darwin birth `python3` and `/bin/ps`.
     - **anything else:** ambiguous, so the authority is retained.
  4. SIGKILL and settle the owner, in a `finally` on every path, so the owner is never left stopped. The birth check in `settle` guards against pid reuse.
  5. Hand the bound command identity to `uncapturedAuthority` as `child`. The existing retirement loop then settles members, the command group and the owner in the captured path's order. The group can reach absence only once its zombie leader is reaped, which happens when the owner dies (probed on Darwin).

  `no command started` is reported only when the owner was confirmed live, stopped and identity-bound, and no child is a command, in flight or ambiguous.

  If the owner is already gone before the freeze and `child.json` exists, the receipt identity (pid, birth and the pgid check in `settle`) is bound and handed to the loop, with no freeze or scan. That identity does not depend on `ppid`. If the owner is gone and there is no `child.json`, its children have been reparented, so no claim is possible and the authority is retained. "Retained" means the branch throws before `issued.set(...)`: the temporary root is not removed, and no group is claimed absent.

- **The report names the outcome.** The uncaptured entry is pushed after the uncaptured loop, one entry per name, with an exact format:
  - `Uncaptured custody fixture authority retained: command <pid>`
  - `Uncaptured custody fixture authority retained: no command started`
  - `Uncaptured custody fixture authority retained: command unidentified (<reason>)`, for the in-flight, ambiguous, scan-failure and owner-gone-without-receipt outcomes

  A failed settle adds its own entry. The existing deadline case's `toEqual` (`trusted-docker-custody.integration.test.ts:705-707`) is the only assertion change: it matches the suffixed message with `pids.command`.

- **New fixture mode, `unpublished-command`.** The mode:
  - keeps slow-owner's 4 s wait before the manifest (`trusted-docker-fixture.ts:298`), so `start` gives up and cleanup takes the uncaptured path;
  - holds the owner with `Atomics.wait` for 30 s, longer than the 20 s case bound, after the `pnpm test:docker` spawn returns and before `child.json` can be written;
  - publishes `child.pid` atomically (a `.pending` file, then rename) to a gitignored `.run/` path before blocking;
  - is listed in `deniedGroupObservations` (`['0','EPERM']`), so its preload is written;
  - is added to the held list in `fixture-child.mjs` (`:350`), so the leaf waits for release.

  The new case proves the window from the published pid: at cleanup the command group is live and `child.json` is absent. Its `finally` kills the owner and `-command`, as at `:710-718`.
  - Before the fix, the command group outlives cleanup (red).
  - After the fix, `groupIsAbsent(command)`, the owner is gone, and the aggregate has exactly one entry: `…: command <pid>` (green).

## Triage

```text
Issue type: bugfix (test fixture)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: trusted custody fixture cleanup (every custody case's teardown); a wrong match could signal a foreign group; a stopped owner left behind would hang
Selected risk packs: Concurrency / shared state / ordering (freeze before read; owner/child/group race); Error handling / rollback / partial outputs (no match vs ambiguous vs scan failure; never claim absence); File IO / path safety / overwrite (child.json read under a frozen owner); Auth / permissions / secrets (process identity authority: only an identity-bound own descendant is signalled)
Evidence floor: new window case red before / green after; existing deadline case and custody/retirement files green; 5 loaded pnpm test:integration runs; pnpm check; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `trusted-docker-verification`: a custody start killed before it published its command still has that command's group retired.

## Impact

- `platform/test/trusted-docker-fixture.ts`
- `platform/test/trusted-docker-custody.integration.test.ts`

No change to `scripts/trusted-docker-*.mjs`. The PR asks for white-box review, because this touches custody process-ownership semantics.
