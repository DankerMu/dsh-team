# Design

**Change surface:** the `vitest.config.ts` stack ledger and `testTimeout`; `typingBrowse` and `noticeSpan`'s shared tail in `office-rewrite-stack-fixture.ts`; the `forgottenShape` python in `document-server-forgotten-fixture.ts`.

**Governing invariant:** every `openHinted` and `typeAndSave` execution, including the `loaded` hook it invokes, is counted in the stack ledger at its serial bounds, times its execution count. The case timeout therefore covers the editor-opening waits, and a stalled opening wait fails with its own label before vitest's `Test timed out`. All other lane waits stay in the ledger's margin as before (`vitest.config.ts:115`: "a margin, not the sum of every per-step bound").

## Call-site table (#1)

T is the session timeout (60 s). "Default" is Playwright's default action timeout for the stack browser, which the implementation verifies (the reviewer assumed 30 s).

- **`openHinted` per execution:** row T, `row.click()` default, editor settled T, refusal T, `shoot` default. About 3T + 2·default.
- **`typeAndSave` per execution:** area T, ready T, box T, click T, which is 4T, plus its `loaded` hook.

The implementation fills in the seconds and the sums, and shows the arithmetic in the ledger comment and the PR.

| #   | call site                                          | function    | executions per run                                                                                                | `loaded` hook / extras                                                                                                                                                                                                                                                                                                                                             | already counted                               |
| --- | -------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 1   | `office-hints-stack-fixture.ts:405`                | openHinted  | 1 (hints lane #439)                                                                                               | —                                                                                                                                                                                                                                                                                                                                                                  | none (no ledger line)                         |
| 2   | `office-editor-stack-fixture.ts:336` (editAndSave) | openHinted  | 3 serial in the editor lane (A side, `:445,500`; B runs in parallel), plus 1 in the idle lane (`office-idle:218`) | —                                                                                                                                                                                                                                                                                                                                                                  | one T per load (#440 editor: 3; #440 idle: 1) |
| 3   | `office-editor-stack-fixture.ts:337` (editAndSave) | typeAndSave | 3 + 1 as row 2                                                                                                    | same-name meeting: `gate` (60 s, counted by the 180 s line), plus `whenBoth` → `bothOpen` → `distinctKeys` 5 s poll and its last registry exec (`:371-377`), not counted; idle: the 210 s hold (HOLD_MS, counted), `editorFontNames` `locator.evaluate` at default (`office-idle:153-158`), and `idleMinutes`/`heldRunning` admin requests (`:84-96`), not counted | the typings: none                             |
| 4   | `office-rewrite-stack-fixture.ts:539`              | openHinted  | 4 (`rewriteCase` runs 4 cases, `:807-810`)                                                                        | —                                                                                                                                                                                                                                                                                                                                                                  | one T per case (#442, #657 A4)                |
| 5   | `office-rewrite-stack-fixture.ts:542`              | typeAndSave | 1 (unsaved only)                                                                                                  | —                                                                                                                                                                                                                                                                                                                                                                  | the unsaved case's extra 60 s typing          |
| 6   | `office-rewrite-stack-fixture.ts:560`              | typeAndSave | 4                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                  | one T per case                                |
| 7   | `office-rewrite-stack-fixture.ts:619`              | typeAndSave | 1 (typing)                                                                                                        | —                                                                                                                                                                                                                                                                                                                                                                  | #652's typing waits (one T each)              |
| 8   | `office-rewrite-stack-fixture.ts:658`              | openHinted  | 1 (typing)                                                                                                        | —                                                                                                                                                                                                                                                                                                                                                                  | #652's editor load (one T)                    |
| 9   | `office-rewrite-stack-fixture.ts:679`              | typeAndSave | 1 (typing)                                                                                                        | —                                                                                                                                                                                                                                                                                                                                                                  | #652 (one T)                                  |
| 10  | `office-forgotten-stack-fixture.ts:299`            | openHinted  | 1                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                  | #624: one T                                   |
| 11  | `office-forgotten-stack-fixture.ts:302`            | typeAndSave | 1                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                  | none                                          |
| 12  | `office-forgotten-stack-fixture.ts:399`            | openHinted  | 1                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                  | #624: one T                                   |
| 13  | `office-forgotten-stack-fixture.ts:400`            | typeAndSave | 1                                                                                                                 | recover's `dismissAlert` (20 s + four T waits, `:368-384`)                                                                                                                                                                                                                                                                                                         | none                                          |

**Also added:**

- **#731's masked-session locale wait:** one T for each masked session. There are six: rewrite clean, unsaved, xlsx, pptx and typing, and forgotten edit. It counts only if #731 has merged when this change lands.
- **#3's typing quiet window:** 15 s.

**Expected size.** This is the reviewer's estimate, to be confirmed by the implementation's arithmetic. `testTimeout` grows by about 5500 s, from 12050 s to about 17600 s (about 4.9 h). A real full run takes about 1338 s (#731's evidence), so no green run changes. The cost is a longer wait before a hang in an unbounded check fails; that check is a non-goal.

**Sibling surfaces:**

- `openHinted` and `typeAndSave` are unchanged.
- Other lane waits stay in the margin.
- `until` compares its deadline only after its check returns, so a hung `page.evaluate` cannot be cut. This is recorded, not changed.

## Typing quiet window (#3)

**Order in `typingBrowse`.** `latched.end` and `notices.end` keep their meaning as recorded evidence: "seen from the start of typing until the end" (`TypingEvidence`, `:211-212`). That only holds if they are read before the re-arm.

1. read until saved;
2. `shown` / `cleared`;
3. read `facts()`, which needs `NOTICE_TIMES` before any re-arm;
4. re-arm `NOTICE_LATCH`;
5. wait 15 s;
6. read `quietWindow`.

**Shared tail.** Steps 4–6 are the shared tail that `noticeSpan` also uses. Steps 1–6 become one exported function that the `standIn()` page drives. `standIn` answers `NOTICE_TIMES` and `FRAMES_SEEN` (or the function takes `facts` as a callback), and it clears the notice times on `NOTICE_LATCH`, as the real latch does.

**Mutants:**

- A notice injected after the re-arm gives `quiet: false`, which the case must detect.
- Replacing the tail with an instantaneous read must turn the case red.
- Moving the `facts()` read after the re-arm must turn the case red, because the cleared notice times change `cleanThenCleared`.

**Naming.** The new field is `quietWindow`: in the window after the clear, each notice was not seen, all `false`. The name avoids the inverted sense of `noticeSpan`'s `quiet`. `MEASURED_TYPING`'s new field is a prediction until task 2.2's stack run confirms it.

**Must preserve:**

- every scenario of "Office 改写车道的提示条断言有区分力" and "Office 改写车道覆盖 XLSX 与 PPTX";
- every existing case's expected facts, with `quietWindow` added only to typing;
- `EXPECTED_TYPING.dirty` and `cleanThenCleared` computed from `facts()` read before the re-arm.

## Forgotten diagnostic (#5)

- **Per-entry handling.** Each entry's `isdir`, `lstat` and `listdir` sit inside one `try/except FileNotFoundError: continue`. Anything else still raises.
- **Red cases.** A monkeypatched prelude deletes an entry:
  - (a) after the first `listdir`;
  - (b) after `isdir`, before the inner `listdir`.

  Both make main exit non-zero and green after the change. The remaining entries are still reported.

- **Must preserve:**
  - the sealed `0o000` case (`document-server-forgotten-fixture.integration.test.ts:223-233`) still fails;
  - the shape output carries digests, not keys.

## Seams under test

- **The ledger.** Arithmetic only. The PR shows the table with its seconds and the new `Sum:`.
- **#3.** The extracted typing post-save function, driven by `standIn()`.
- **#5.** The real python, run by `storeLane` with a monkeypatched prelude: (a) delete after the first `listdir`; (b) patch `os.path.isdir` to delete the entry after returning True.

## Required evidence

- Red before the change and green after for:
  - the `quietWindow` notice case and the two mutants (instantaneous read, `facts()` after the re-arm);
  - both #5 windows;
  - the sealed case still failing.
- One green `pnpm test:stack` on the final head, with typing `quietWindow` all `false` on real DSH.
- The exact-head VPS lane.

## Review focus

- The completeness of the call-site table against the code, and its execution counts.
- That `facts()` is read before the re-arm.
- That only `FileNotFoundError` is tolerated.

## Non-goals

- Item 4: XLSX/PPTX unsaved cases. It is a separate slice and keeps #716 open.
- Shortening any real lane wait.
- Racing `until` against a hung check.
