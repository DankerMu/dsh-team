## Risk packs

- **Concurrency/ordering (selected).** Read the latch before re-arming it; the store race (tasks 1.2, 1.3).
- **Legacy compatibility (selected).** The lane facts and the ledger arithmetic (tasks 1.1, 1.2).
- **Error handling (selected).** Tolerate only `FileNotFoundError` (task 1.3).
- **Not selected:** schema, auth, security, resources, release.

## Acceptance mapping (#716; item 4 in a later slice)

- **#1.** One stretched wait already fails with its phase on main; this is recorded. The cumulative bound for the opening and typing helpers now holds: `testTimeout` includes the table sum (task 1.1).
- **#3.** Removing the quiet window turns the extracted typing tail red (task 1.2).
- **#5.** A mutation that deletes an entry between the steps no longer fails the diagnostic; both windows are covered (task 1.3).
- **All.** `pnpm test:stack` passes (task 2.2).

## Must preserve

See design.md.

## 1. Implementation

Write each case first and record its red output.

- [x] 1.1 Fill in the 13-row call-site table (design.md) with the execution counts:
  - verify Playwright's default action timeout for the stack browser;
  - count every wait at its bound;
  - add the additions to the ledger text, the `Sum:` line and `testTimeout`;
  - rewrap the two 101-character lines.

  Show the arithmetic in the PR.

- [x] 1.2 Extract the typing post-save segment and the shared tail. Read `facts()` before re-arming the latch.
  - Integration cases on `standIn()`, which now answers `NOTICE_TIMES` and `FRAMES_SEEN` and clears the times on the latch:
    - an injected notice after the re-arm gives `quietWindow` not all `false`;
    - the instantaneous-read mutant goes red;
    - the `facts()`-after-re-arm mutant goes red.
  - Add `quietWindow` to `EXPECTED_TYPING`, the measured typing facts, `typingRun`/`unpatched` and `docs/LOCAL_STACK.md`.
  - Add 15 s to the ledger.
- [x] 1.3 Per-entry `FileNotFoundError` tolerance in `forgottenShape`.
  - Integration red/green for windows (a) and (b).
  - The sealed case still fails.

## 2. Verification

- [x] 2.1 Record each red before and green after. Run `pnpm test:integration`, `pnpm typecheck`, `pnpm lint`, `pnpm dead-code` and `pnpm duplicate-code`.
- [x] 2.2 One green `pnpm test:stack` on the final head (the typing `quietWindow` all `false` on real DSH). Then run the exact-head trusted VPS `pnpm test:docker` and `pnpm test:deploy`.
