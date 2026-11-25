# Count every serial Office opening wait in the stack ledger, hold a typing quiet window, and tolerate a vanishing forgotten entry

## Why

Issue #716 (residue of #650/#656/#657). Line numbers refer to main `e90a167`. This change covers items 1, 2, 3 and 5. Item 4 (XLSX/PPTX unsaved cases) needs a stack measurement before anything can be pinned, so it is a separate slice. #716 stays open until that slice lands.

1. **The ledger undercounts serial opening waits.**
   - The stack ledger (`vitest.config.ts`) counts an editor opening as one 60 s session timeout.
   - `openHinted` (`office-hints-stack-fixture.ts:168,186-188`) runs three serial waits at the session timeout: the row, the editor settling, and the ServiceWorker refusal. It also runs a `row.click()` with no explicit timeout and a final `shoot`.
   - `typeAndSave` (`office-editor-stack-fixture.ts:223-228`) runs four Playwright waits at `timeout` (area, ready, box, click) and the caller's `loaded` hook.
   - Several call sites are not in the ledger at all:
     - the A side of #440's three `typeAndSave` calls;
     - the forgotten lane's two `typeAndSave` calls;
     - the hints lane (#439).
   - In the worst case the sum reaches vitest's `testTimeout` first. The run then fails as an unattributed `Test timed out` and skips the RAGFlow restore `finally` (`docs/LOCAL_STACK.md` §5).
   - What main already does: when one wait stalls, it already fails with that wait's own label or Playwright locator. The acceptance line about stretching one wait is therefore already met. The defect is the cumulative bound.
2. **Two ledger comment lines exceed print width.** Two lines in `vitest.config.ts` are 101 characters long.
3. **The typing case has no quiet window.**
   - `typingBrowse` (`office-rewrite-stack-fixture.ts:682-690`) reads `cleared` and `end` once each.
   - Unlike `noticeSpan` (`:500-504`), it does not re-arm the latch and observe a quiet window after the clear (#657 A1).
4. **`forgottenShape` can fail on a vanishing entry.**
   - `document-server-forgotten-fixture.ts:73-87` lists the store, then calls `isdir`, `lstat` and `listdir` on each entry.
   - An entry that disappears in between raises `FileNotFoundError`, so the diagnostic exits non-zero and fails the lane (`office-forgotten-stack-fixture.ts:426,449`).

## What Changes

- **#1. Bound the ledger, not the behaviour.** The ledger counts every serial bounded wait of every `openHinted` and `typeAndSave` call site at its bound. Lane behaviour does not change: no wait is shortened, nothing is measured, and no real lane can be cut.
  - design.md lists all 13 call sites with their execution counts. For each one it gives the waits and their bounds, what the ledger already counts, and the seconds added. `loaded` hooks are counted at their own caller's bound. A wait already counted elsewhere (the same-name `gate`, the idle hold) is marked as such.
  - The ledger's `Sum:` line and `testTimeout` grow by the total, and the ledger text names the call-site table.
  - Playwright actions with no explicit timeout (`row.click()`, `shoot`) are counted at Playwright's default action timeout as configured for the stack browser. The implementation verifies that value.
- **#2.** Rewrap the two 101-character lines as part of the ledger edit.
- **#3. Typing quiet window.**
  - `typingBrowse` reads its notice and latch facts (`facts()`: `NOTICE_TIMES`, `staleLatched`, `staleCleared`) **before** re-arming the latch. `NOTICE_LATCH` resets `__dshTeamNoticeTimes` (`:343-361`).
  - It then re-arms the latch, waits the 15 s window and reads `quietWindow`. This tail is the same one `noticeSpan` uses, as one shared function.
  - The typing case's post-save segment (read until saved → shown → shared tail) is extracted into one function that the existing `standIn()` page can drive. A notice injected after the re-arm then makes `quietWindow` not all `false`. If `typingBrowse` stops using the tail, the integration test goes red.
  - `latched.end` and `notices.end` stay as recorded evidence. `quietWindow` (each notice not seen in the window) is added and asserted all `false` in `EXPECTED_TYPING`, the measured typing facts, `typingRun`/`unpatched` and the `docs/LOCAL_STACK.md` typing row.
  - The ledger adds 15 s.
- **#5.**
  - Each entry is handled inside `try/except FileNotFoundError`, so an entry that vanishes during inspection counts as absent.
  - Both windows are covered: vanishing after the listing and before `isdir`/`lstat`, and vanishing after `isdir` and before the inner `listdir`.
  - Other `OSError`s, such as permission errors, still fail.

## Triage

```text
Issue type: test-infrastructure bugfix
Fixture level: expanded (openHinted/typeAndSave are shared by five lanes and nine call sites)
Upstream suggested level: absent
Blast radius: vitest.config.ts stack ledger and testTimeout; office-rewrite typing case facts; document-server-forgotten diagnostic; their integration tests; docs/LOCAL_STACK.md typing row; no product code; no lane timing change except the 15 s typing window
Selected risk packs: Concurrency/ordering (latch read-before-re-arm, store race); Legacy compatibility (existing lane facts, ledger arithmetic); Error handling (diagnostic tolerance limited to FileNotFoundError)
Evidence floor: integration red/green for #3 (extracted typing tail driven by standIn, mutant) and #5 (both race windows); ledger arithmetic checked against the call-site table; one green pnpm test:stack on the final head (the typing quiet window on real DSH); exact-head VPS pnpm test:docker + pnpm test:deploy
```

## Capabilities

### Modified Capabilities

- `stack-verification`:
  - The stack case timeout covers every serial opening wait.
  - The typing rewrite case holds a quiet window.
  - The forgotten-store diagnostic tolerates a vanishing entry.

## Impact

- `vitest.config.ts`
- `platform/test/office-rewrite-stack-fixture.ts`, `document-server-forgotten-fixture.ts`, and their integration tests
- `docs/LOCAL_STACK.md`
- Lands after #731 (#717), which adds a masked-session locale wait per rewrite case. The ledger counts that wait too, because #731 did not add it.
