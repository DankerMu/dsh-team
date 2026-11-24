## Risk packs

- **Concurrency / shared state / ordering — selected.** Tasks 1.2, 1.3.
  - Close, the member's exit and the group polls interleave.
  - `closedAt`, `firstObservedAt` and `preClosePolls` order them.
- **Error handling / rollback / partial outputs — selected.** Tasks 1.1, 1.2.
  - A missing or partial receipt fails explicitly.
  - An `unavailable` piece fails (1A).
- **File IO / path safety / overwrite — selected.** Task 1.2.
  - The receipt is cross-process.
  - It is written atomically under the gitignored `.run/`, never in the reviewed checkout.
- **Not selected:** product code, secrets, config, release.

## Acceptance-criteria mapping (#658)

- **AC1** (a walk that throws fails the killOwner case, and passes before the fix) → 1.1, 1.3a.
- **AC2** (positive tree case; a walk that returns empty fails it) → 1.1, 1.3b.
- **AC3** (a member that exits before close is caught) → 1.2, 1.3c. The issue's literal mutant (exit at SIGUSR2) is already red before the fix, because `memberTiming` and `>= 300` fail. Tasks 1.3c uses mutants that the old oracle passes.
- **AC4** (no preload record or receipt fails explicitly) → 1.2, 1.3d.
- **AC5** (nothing lengthened, retried or removed; both files green three times locally) → 2.1.

## Must preserve

See design.md § Must preserve.

## 1. Implementation

- [x] 1.1 (1A) and (1B).
  - (1A): the three `:\n` success forms; `owner process tree:\n$`; the negative check limited to those three names.
  - (1B): a positive tree case on a live root with a known child, sharing one walk implementation with `retirementScene`.
- [x] 1.2 (2): the preload's `post-close-member` mode, scoped to `own`.
  - The command child, matched exactly as `pnpm test:docker` with a match count of 1, records `closedAt` through `once('close')`.
  - It counts negative-pid, signal-0 calls: `firstObservedAt`, `presentPolls` for calls that returned normally, and `preClosePolls`.
  - Each update is written synchronously and atomically to a receipt under `.run/`.
  - Assertions, in one helper in the new `-fixture.ts`: match count 1, `preClosePolls === 0`, `closedAt <= firstObservedAt`, `firstPresent === true`, `presentPolls >= 1` and `exited > firstObservedAt`.
  - A missing or partial receipt fails explicitly.
  - The second post-close case is unchanged.
- [x] 1.3 Mutants. Record each before/after text.
  - (a) `/bin/ps` replaced with a missing path: killOwner green before, red after.
  - (b) A walk returning `''`: the positive tree case is red.
  - (c) Old oracle green, new oracle red:
    - the member exits at SIGUSR2, but atomically writes a record satisfying the old arithmetic (`{vanished: now - CLOSE_MEMBER_DELAY_MS, exited: now}`);
    - optionally, a leaf that on SIGINT starts a detached process holding stdout for about 500 ms, delaying close past the member's exit. Use it only after confirming that close is actually delayed.
  - (d) The receipt write removed: the case fails explicitly.

## 2. Verification

- [x] 2.1 Both files green three times in a row locally. `pnpm lint`, `pnpm typecheck` and `pnpm check` pass.
- [x] 2.2 Exact-head CI `layer3-integration` is green; it runs these files on Linux.
- [x] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy` (the repository gate).
