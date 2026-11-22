## Risk packs

- **Concurrency / shared state / ordering — selected.** The owner is frozen before anything is read, and kill/settle ordering is fixed. Tasks 1.1, 1.3.
- **Error handling / rollback / partial outputs — selected.** Covers no match, an ambiguous match and a failed scan, and guarantees the owner never stays stopped. Tasks 1.1, 1.3.
- **File IO / path safety — selected.** `child.json` is read while the owner is frozen. Task 1.1.
- **Auth / permissions / secrets — selected.** Only an own descendant bound to an identity is signalled. Task 1.1.
- **Not selected:** product scripts, config, release.

## Acceptance-criteria mapping (#661)

- **AC1** (new window mode; red before the fix, then green with the group absent, the owner absent and a single uncaptured entry) → 1.2, 1.3.
- **AC2** (the existing deadline case and the custody/retirement files pass; five loaded `test:integration` runs) → 2.1.
- **AC3** (the settled pid, or "no command started", appears in the report) → 1.1, 1.3; the format is given in the proposal.

## Must preserve

See design.md § Must preserve.

## 1. Implementation

- [x] 1.1 In a sibling `*-fixture.ts`, add these module-level functions:
  - freeze and stop confirmation;
  - the `ps -ww` scan, plus a pure classifier;
  - binding through `observeProcess`.

  Then, in the uncaptured branch, follow proposal.md § What Changes:
  - freeze the owner;
  - bind the command from `child.json` or the scan;
  - SIGKILL and settle the owner in a `finally`;
  - set `child` on the authority, so the existing loop settles the group after the owner.

  Push one suffixed entry per name after the loop. In-flight, ambiguous, scan failure and owner-gone outcomes throw before `issued.set` (retained).

- [x] 1.2 Add the `unpublished-command` mode:
  - slow-owner's pre-manifest wait;
  - a post-spawn `Atomics.wait` hold that publishes `child.pid` to `.run/` first;
  - a `deniedGroupObservations` entry;
  - membership in the held list of `fixture-child.mjs`.
- [x] 1.3 Add the window case:
  - prove the window from the published pid;
  - assert the group and the owner are absent and that the aggregate is exactly `[…: command <pid>]`;
  - its `finally` kills the owner and `-command`.

  Show it red before the fix and green after. Update the existing deadline case's single `toEqual` to the suffixed message. Add stub cases for every classifier outcome.

## 2. Verification

- [ ] 2.1 Run the custody and retirement integration files three times in a row. Then run five loaded `pnpm test:integration` runs, `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [ ] 2.2 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
