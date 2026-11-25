## Risk packs

- **Error handling (selected).** Only a validated `result.json` whose command is settled hands authority back. An unsettled or unreadable one keeps the authority. Task 1.1.
- **Resources (selected).** The owner's temporary root is deleted once and is never deleted while the group may still be alive. Tasks 1.1, 2.2.
- **Concurrency/ordering (selected).** Order of `launch.json`, `child.json` and `result.json`; the launch race. Tasks 1.1, 1.2.
- **Not selected:** schema, auth, security, release, docs.

## Acceptance mapping (#718)

- **#1.** An owner that writes `result.json` after expiry has its root deleted and reports a single failure (task 1.1).
- **#3.** A delayed `start` still produces the expected error, not `ENOENT` (task 1.2).
- **#2.** No new `dsh-team-docker-*` or `dsh-team-custody-audit-*` directories after a full integration run. Measured and reported in task 2.2.

## Must preserve

See design.md § Must preserve.

## 1. Implementation

Write each case first and record its red output.

- [ ] 1.1 `boundCommand` third step, the `finished` outcome, and the fixture branch that skips the retained failure for `finished` only.
  - Stub rows (design.md § Seams under test). The settled row is red before the change (retained, `owner gone without receipt`) and green after (`command finished`, settle events, no failure). All other rows are retained both before and after.
  - Real-owner late-finish case, released and unreleased rows. Released: the temporary root is deleted and only the case's own failure is reported. Before the change it is red, with a second "authority retained" failure and the root left behind.
- [ ] 1.2 Start-delay hook, an `it.each` (no delay, delayed) over the first case, `waitFor`/`ownerOf`, and re-derived bounds.
  - Red on main: the delayed row fails with `ENOENT … launch.json`. Kill the leaked owner and leaf by hand.
  - Green: both rows report the intended error.

## 2. Verification

- [ ] 2.1 Record each red before the change and green after. Run the touched files, then `pnpm test:integration`, `pnpm lint`, `pnpm typecheck`, `pnpm dead-code` and `pnpm duplicate-code`.
- [ ] 2.2 Name-list leak diff (design.md § Leak measurement) around one green full `pnpm test:integration` on the final head, with nothing else running. Report the diff on #718. If it is non-empty, the PR uses `Refs` and a follow-up issue is filed. Run the exact-head trusted VPS `pnpm test:docker` and `pnpm test:deploy`.
