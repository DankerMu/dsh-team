# Design

## Change surface

- The uncaptured branch of `cleanup` in `trusted-docker-fixture.ts`, together with `uncapturedAuthority`.
- One new mode and its preload fragment.
- One custody case.

## Must preserve

- The captured path: `captureStart`, `killOwner`, and the retirement loop's order (members, then child group, then owner, then the temporary root).
- `settle`'s identity checks, ESRCH tolerance and `waitForAbsence`.
- `recordedProcesses`.
- Every existing mode's preload and behaviour.
- The existing deadline case, its assertions and its `finally`. The only exception is the single `toEqual` at `:705-707`, which now expects the suffixed message.
- The uncaptured entry's base message `Uncaptured custody fixture authority retained`, which is kept as the prefix.
- `budget.reserve()` and the cleanup budgets.
- `scripts/` is untouched.
- The 800-line `max-lines` limit (it skips blank and comment lines). The fixture has 841 raw lines. The fixture already has 777 effective lines, and `createTrustedDockerFixture` and `prepareCustodyRepository` are each about 187 lines against the 200-line function cap. So the freeze, scan and classifier go into module-level functions in a sibling `*-fixture.ts`, as `trusted-docker-close-fixture.ts` was split out in #688.

## Governing invariant

Uncaptured cleanup signals only processes it has bound to an identity it owns:

- the owner, from `launch.json`;
- the owner's direct child that leads its own group and runs the verification command.

It never claims that the command group is absent while that is uncertain. It never leaves the owner stopped, with one exception: if the owner's settle fails and a fresh identity check then cannot confirm the owner, the SIGKILL backstop is skipped and the settle failure is reported. A visible stopped process is preferred to signalling a pid that may have been reused (review round 1).

## Decisions

See proposal.md § What Changes for the sequence, the classifier and the outcomes. The reasons:

- **Kill the owner before settling the group.** pnpm is the owner's direct child. After the group is killed, pnpm stays a zombie until the owner reaps it or dies. While it is a zombie, `kill(-pgid, 0)` returns EPERM on Darwin; this was probed, and it turned to ESRCH within 50 ms of killing the parent. On Linux the zombie leader keeps the pgrp until it is reaped. `groupIsAbsent` counts only ESRCH, so settling the group while the owner is frozen can never reach absence. The captured path already uses the correct order, and it is reused unchanged.
- **Confirm the stop.** `kill(pid, 'SIGSTOP')` returns before the target has stopped. A bounded check that `stat` starts with `T` makes "frozen" an observed fact.
- **Classify in-flight forks.** On Linux, libuv forks first, and the child runs `setsid` and then `execvp`. A stop that lands in that gap leaves a child with the owner's command line and, before `setsid`, the owner's pgid. Treating that child as "nothing" would orphan it.
- **Use `-ww`.** It prevents a truncated command line from producing a false zero match.
- **Producers.** `ownVerificationProducers` (`verification-producer.mjs:349-377`) only opens a socket and spawns nothing at that point. The owner's other children are not detached. Both facts were checked at `e075cff`.

## Sibling surfaces

- The captured path's `killOwner` runs after `captureStart`, outside the window.
- #690 (EPERM on a zombie group in `settle`) is a separate issue. With this order, the new case has the same exposure as the existing case: only the short launchd reap window after the owner is killed. Use the same terminal `groupIsAbsent` assertion form as `:709`.
- The captured path has the same orphan when `captureStart` times out with "Command identity unpublished" (`:711-719`). That is out of scope and filed as a follow-up.

## Seams under test

- **The `unpublished-command` mode's preload**, described in the proposal.
- **The scan classifier**, a pure module-level function from `ps` rows and the owner's identity to an outcome. Stub rows cover each outcome:
  - one command;
  - zero children;
  - in flight, persisting;
  - ambiguous;
  - the owner gone before the freeze, with `child.json` present: bound from the receipt;
  - the owner gone before the freeze, with no receipt: retained.
- **`ps` failure** is stubbed at the scan seam, through an injected runner that returns a nonzero status, so the classifier stays a pure function of rows.

## Required evidence

- **The window is proven.** At cleanup entry, `child.json` is absent and the command group is live.
- **Red before the fix.** The command group survives cleanup.
- **Green after the fix.**
  - The group is absent.
  - The owner is absent.
  - The aggregate has exactly one entry, `…: command <published pid>`.
- **The existing deadline case** passes with its suffixed message.
- **Each classifier outcome** has a stub case.
- **No stopped process remains.**
- **Load.** Five loaded `pnpm test:integration` runs (§56), plus the custody and retirement files.

## Non-goals

- Post-hoc collection of a product owner's group after an external SIGKILL.
- The owner's write ordering.
- #629, #637, #656 and #690.

## Review focus

- Identity binding of the scanned child.
- SIGSTOP/SIGKILL pairing on every path.
- No absence claimed on uncertainty.
- Ordering against `uncapturedAuthority`.
