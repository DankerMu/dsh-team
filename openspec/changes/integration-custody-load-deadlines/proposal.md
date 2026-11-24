# Integration load deadlines: custody rows

## Why

This is #687 slice 2: the trusted-docker-custody rows #5–#8. Slice 1, the main table, merged in #708. Line numbers refer to main `8e0f0a7`; the issue's numbers have drifted by 1–2. C is `platform/test/trusted-docker-custody.integration.test.ts`, and F is `platform/test/trusted-docker-fixture.ts`.

- **#5 and #6 (class D): held cases run out of their fixture budget.**
  - `custodyCase` gives each held case a fixture deadline of `CASE_MS - RESERVE_MS` = 15 s (C:39-47). Its vitest bound is a separate literal `20_000` on each case.
  - Every `fixture.command` is a synchronous spawn, through `pnpm` when it uses the wrapper and otherwise straight through `node`. Its 15 s timeout (F:671) is cut by `budget.run` to what remains (F:140-165).
  - Setup consumes that budget before the step under test. It covers repository preparation (git init/add/commit), the start, leaf readiness, `observeProcess` cold starts and `ps`. No timing of it is recorded; only cleanup is measured, at load 7 (C:37).
  - Under load the `status` at C:521 was cut with 2314 ms left. The `cancel` calls at C:554, :729 and :771 were cut the same way.
- **#7 (class D): a fixed 8 s budget has to cover the same setup.**
  - The terminal-wait case (C:644-668) uses a fixture deadline of `Date.now() + SPENT_CASE_MS` (8 s). It relies on setup leaving less than `TERMINAL_WAIT_MS` (10 s, C:193) after leaf readiness, so that the case deadline, not the 10 s cap, ends `awaitTerminal`, which waits to `min(now + 10 s, deadline)` (C:198).
  - Under load, setup plus start plus leaf readiness took more than 8 s, so `leafReady` (C:113: `min(now + LEAF_READINESS_MS, deadline)`) failed with `readiness-deadline {"state":"running"}`.
  - That failure cannot tell whether the 5 s readiness cap or the case deadline came first.
- **#8 (class C): reads come before the files exist.**
  - The slow-owner case (C:679-719) lets the start run only in the last 2.5 s of a 5 s fixture deadline, so `budget.run` SIGKILLs the start's direct `pnpm` child (F:155, F:672).
  - The start CLI's `node` process underneath is orphaned and keeps running. It is the process that creates `base` and the invocation directory (`scripts/trusted-docker-owner.mjs:93-95`), writes `request.json` (:111), spawns the owner, and only then writes `launch.json` (:137).
  - The owner's own 4 s hold (F:310) comes later and does not affect these files.
  - The case reads `readdirSync(base)` and `launch.json` at once (C:689-690). Under load the orphaned CLI has not reached :93 or :137 yet. The callback then throws ENOENT, and that error replaces the expected cleanup `AggregateError`.
  - The `child.json` read just below already waits, bounded by `COMMAND_LAUNCH_MS` (C:691-694).

## What Changes

- **A measuring pass, before any constant changes.**
  - Five loaded full `pnpm test:integration` runs, with temporary instrumentation and the budgets temporarily raised so that no run is truncated: `CASE_MS` and `SPENT_CASE_MS` set to 60 s. All of it is reverted afterwards.
  - The instrumentation is one wrapper in `custodyCase` (C:42-47) that records, per held case, the callback's elapsed time and the cleanup's elapsed time. This covers every held case, and re-checks `RESERVE_MS` under load ≥ 13 against its load-7 basis.
  - It also records, per held case and in #7, the time from the start's return to leaf readiness. That shows whether `LEAF_READINESS_MS` (5 s) or the case deadline binds.
  - C:521, :554, :729 and :771 are attributed from the same records.
- **#5/#6: `CASE_MS` from the measured maximum** of the callback time, plus a stated margin.
  - The comment at C:34-39 records the basis: the load range, the maximum, the margin, and the cleanup maximum against `RESERVE_MS`.
  - `RESERVE_MS` changes only if the measured cleanup exceeds it.
  - Only the `custodyCase` cases' literal `20_000` becomes `CASE_MS`. C:668 (#7) and C:719 (#8) do not go through `custodyCase`: C:719 keeps `20_000`, and C:668 becomes #7's named sum. The comments at C:34, C:70 and C:673-674 that name 20 s are updated.
  - If leaf readiness under load approaches `LEAF_READINESS_MS`, that constant is re-derived the same way, with its basis comment. This is the issue's "或 5 s 的就绪上限".
- **#7: an explicit precondition.**
  - `SPENT_CASE_MS` becomes the smallest value that covers the measured setup maximum plus a margin. This case always runs to its own deadline, so every second added here is paid on the green path too; the PR states that cost.
  - The case's vitest bound becomes `SPENT_CASE_MS` plus the cleanup reserve, as a named sum.
  - After `leafReady`, the case waits `max(0, remaining - (TERMINAL_WAIT_MS - margin))`, with a stated margin (for example 2 s), so that less than `TERMINAL_WAIT_MS` remains.
  - **The wait must be reachable.** The PR reports the unloaded remaining time after leaf readiness on the final `SPENT_CASE_MS`.
    - If that is never ≥ `TERMINAL_WAIT_MS - margin`, the wait is dead code. It is then dropped, and the comment argues `SPENT_CASE_MS - setup < TERMINAL_WAIT_MS` from the measurement.
    - Otherwise it stays, and its mutant must go red on the final constants. Only then are `since` and `left` (C:653-654) taken, so C:659's `< left + 1000` keeps its strength, and C:198's `min` picks the case deadline.
  - Every assertion of the case is unchanged.
- **#8: wait for the event.**
  - After the killed start, the case waits until `base` exists (tolerating its absence) and holds an invocation directory with a `launch.json`. Only then does it read the owner. The existing `child.json` wait follows.
  - Both waits share **one** `until` from the same `COMMAND_LAUNCH_MS` window, so the 20 s case bound still holds.
  - At expiry the new wait throws `Slow start published no launch`, beside the existing `Slow owner launched no command`. It never throws ENOENT.
  - The fix relies on the start CLI's `node` process outliving the SIGKILL of its `pnpm` parent. One measured run in the implementation confirms this, and the PR records it.
- **One poll helper, for canonicality and `max-lines`.**
  - #711's local `waitFor(path, milliseconds, missing)` (in `trusted-docker-uncaptured-fixture.integration.test.ts`) moves into F and is exported.
  - **The signature changes on purpose:** it becomes `waitFor(ready: () => boolean, milliseconds, missing)`. #8 must wait for "`base` holds a directory entry whose `launch.json` exists", and that directory's name is unknown until the CLI creates it (`trusted-docker-owner.mjs:93-95`).
  - #711's two calls become `() => existsSync(p)`. C's `child.json` loop and #8's new wait use the same helper.
  - **The `max-lines` ledger.**
    - C, about 797 counted lines now: −4 for the removed `child.json` loop; +1 for `until`, +2 for the two `waitFor` calls with the predicate, +1 for the import, and about +3 for #7's precondition, margin and named sum. That is about 800–803.
    - F, about 790: about +6 for `waitFor`, so about 796.
    - If C would exceed 800, `ownerOf` also moves into F. That saves C about one net line and brings F to about 798.
    - The PR reports both actual counts. There is no import cycle: C and the uncaptured test already import F.

No assertion is weakened or removed. Product and script semantics are unchanged: `scripts/**`, `platform/src/**`. `vitest.config.ts` is unchanged.

The PR says `Refs #687`. The secondary table (#9–#13) remains for slice 3. This slice is branched after #711 merges.

## Triage

```text
Issue type: test
Fixture level: standard
Upstream suggested level: absent
Blast radius: the custody integration file's case budgets (a larger CASE_MS lengthens every held case's worst case; a larger SPENT_CASE_MS lengthens #7's green path) and #8's read order; C has ~3 lines of max-lines headroom
Selected risk packs: Concurrency / shared state / ordering (#8 reads synchronized on the start CLI's invocation files; #7's precondition made explicit)
Evidence floor: the measuring pass (5 loaded runs, budgets raised to 60 s, instrumentation reverted) and the constants derived from it; #8 mutant (wait removed) red under a temporary start-CLI delay before the owner spawn; #7 mutant (precondition wait removed, SPENT raised) red at the `command status` assertion when setup is fast; custody file green; 5 loaded full pnpm test:integration runs with load and result; pnpm check; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `integration-test-budgets`: the custody held cases' budgets follow a measured basis, and the terminal-wait case's precondition holds by construction.

## Impact

`platform/test/trusted-docker-custody.integration.test.ts`; `platform/test/trusted-docker-fixture.ts` (the moved `waitFor` export); `platform/test/trusted-docker-uncaptured-fixture.integration.test.ts` (its local `waitFor` replaced by the import).

## Acceptance-criteria mapping (#687)

- **D rows #5–#7:** the fixed bounds are re-derived from loaded measurement, with the basis in the comments.
- **C row #8:** the read synchronizes on the start CLI's invocation files, with a distinguishing mutant.
- **The five loaded runs:** recorded for the custody file, alongside slice 1's.
