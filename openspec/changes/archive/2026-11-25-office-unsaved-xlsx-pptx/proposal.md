# Unsaved rewrite cases for XLSX and PPTX, pinned from a stack measurement

## Why

This covers item 4 of #716; items 1, 2, 3 and 5 landed in #737. Line numbers refer to main `1204eb3`.

- **Only DOCX has an unsaved rewrite.** In `CASES` (`platform/test/office-rewrite-stack-fixture.ts:54-59`), the only unsaved rewrite (`typeFirst: true`) is DOCX. For an XLSX or PPTX editor that was typed into but not saved, nobody has measured:
  - whether the refreshed-away session's status 2 is refused (「保存未写回文件」);
  - whether it leaves a forgotten copy;
  - whether both nonces survive.
- **The unsaved outcome is wired to DOCX in two places:**
  - `waitSaveFailed: typeFirst` (`:576`);
  - the integration test's stand-in behaviour, which keys on `id === 'unsaved'`.
- **The digest change after close is a general behaviour, not a PPTX defect.** This is #657 A4 residue. #737's two stack runs recorded every case's saved and closed sha256, and the two differ in all 10 samples: five cases (`clean`, `unsaved`, `xlsx`, `pptx`, `typing`), two runs each (`.workplans/716/stack-*.log`). So closing the editor rewrites the file in every format. PPTX is merely the only one whose byte count also changed (33441→33433, 33449→33436). No fact pins this today.

## What Changes

- **New cases.** `CASES` gains `unsaved-xlsx` and `unsaved-pptx` (`typeFirst: true`). They run after the existing four and before `typing`.
  - Existing case indices stay. Provider rewrite scripts 0–3 stay, and the new scripts are appended at 4 and 5.
  - The hard-coded fours move to six: `CaseIndex`, the configured-scripts `[0,0,0,0]` checks, the integration file-name table, `toHaveLength(4)`, the size-12 checks and the scenario return.
  - `officeRewriteLine` and its print test gain the new ids, so the stack evidence line carries them.
- **Per-case `saveRefused` flag.** This replaces `waitSaveFailed: typeFirst`.
  - `true` for DOCX `unsaved`; `false` for the clean cases.
  - For the new cases it is set from the measurement. "Refused" means the `saveFailed` notice latched within one session timeout after the Agent turn.
  - In the measurement run both new cases wait for it (`waitSaveFailed: true`). #657 A's ledger line already counts 60 s for that wait per case.
  - The integration `measured()` and the stand-in key on it, replacing `id === 'unsaved'`: `arrived.saveFailed`, `span`, `refreshed`, and the `typed` key follow `typeFirst`.
- **`typed` keeps its discrimination for every format.**
  - `rewriteCase` checks the typed nonce with `heldApart(texts, typed, saved)` instead of `holds`. In PPTX, the save typing at the same title point can split a surviving typed nonce, which `holds` would hide; the typing case already uses `heldApart`. DOCX expectations are unchanged.
  - For XLSX, both typings hit the same centre cell, so the save typing replaces the cell and a surviving typed nonce cannot be seen. XLSX's `typed` is therefore recorded but is not evidence of a discard. The discard is proven by the config refresh, the refused save and the forgotten copy. This is stated in `docs/LOCAL_STACK.md`.
- **`closedRewrote`.** `rewriteFacts` gains `closedRewrote: boolean`: whether the closed read's digest differs from the saved read's.
  - It is pinned `true` for the four existing cases now, from #737's ten samples.
  - The new cases get it from the measurement.
  - The typing case stays evidence-only here. It uses `typingFacts`; its own two samples were also `true`.
  - This is the one change to existing cases' expected facts.
- **Measurement first.**
  - **Two runs.** Two `pnpm test:stack` runs with uncommitted instrumentation print the new cases' `rewriteFacts` and every case's digests before any assertion. `expect.soft` at the two case assertions (`:615`, `:617`) keeps a mismatch from stopping later cases.
  - **Disagreement.** Where the two runs disagree on a new case's `closedRewrote`, its expectation is `closedRewrote: null`: recorded, not asserted.
  - **Stop rule.** Pinning stops, and the outcome goes back to review or becomes a product issue, if either measurement shows any of:
    - a third outcome: no refresh (`config.window` 1) with `staleChanged` shown, as in `EXPECTED_TYPING`'s dirty editor;
    - the Agent's or the employee's save nonce missing after the save or the close;
    - an unsaved edit discarded with neither a refused-save notice nor a forgotten copy. For XLSX, a refresh after the unsaved typing counts as the discard, so "refresh, no refused save, no copy" triggers this clause.
  - **Final run.** The final head gets one clean stack run.
    - If that run disagrees with a pinned fact of a **new** case, the fact is unpinned (`null`) and the stack is rerun on the new head.
    - A disagreement on an **existing** case stops the work and goes back to review, like the stop rule, because the spec asserts those cases.
  - **Where the pin state lives.** Whether `closedRewrote` is asserted comes from a per-case flag on `CASES`, next to `saveRefused`, never from `EXPECTED_REWRITE`. `rewriteFacts` outputs `null` for an unpinned case, and there is no `closedRewrote` mutant for it.
- **Mutants.** These run in the integration test, against the pinned expectations, in the measured direction:
  - save outcome flipped (`saveFailed` shown or not shown);
  - forgotten copy flipped;
  - `closedRewrote` false, with equal saved and closed digests, for a case pinned `true`.
- **Ledger.** This follows #737's convention. Per new case:
  - the #657 A4-style line: 985 s;
  - the unsaved typing: 60 s;
  - the helper rows: 3 × 180 = 540 s;
  - one masked session: 60 s.

  That is 1645 s per case, +3290 s in total, so `testTimeout` goes from 17_700 s to 20_990 s. The table's counts also change:
  - `rewriteCase` rows: 4 → 6;
  - the unsaved-only `typeAndSave` row: 1 → 3;
  - masked sessions: 6 → 8.

- **Docs.**
  - `docs/LOCAL_STACK.md` and the `platform/test/README.md` local full-stack evidence gain the new cases, `closedRewrote` and the XLSX `typed` caveat.
  - The two comments that cite `b35c876` (`office-rewrite-stack-fixture.ts:131`, `.integration.test.ts:580`) are restated as "#737's stack runs", because that SHA is not on main after the rebase.
- **Spec.** If a new format's measured outcome differs from DOCX `unsaved`, the existing scenario stating that the PPTX facts equal the XLSX and clean DOCX cases is reviewed. A MODIFIED delta is added only if that scenario's text no longer holds.

## Triage

```text
Issue type: test coverage (measured)
Fixture level: compact (one lane's case table; shared helpers unchanged)
Upstream suggested level: absent
Blast radius: office-rewrite-stack-fixture.ts and its integration test, the stack ledger and testTimeout, docs/LOCAL_STACK.md, platform/test/README.md; the local full-stack lane's runtime (worst case +3290 s; real about +2×2 min)
Selected risk packs: Legacy compatibility (existing cases' facts, provider script indices); Concurrency/ordering (save refusal and close rewrite measured, not assumed)
Evidence floor: two measurement runs' raw facts (dirty tree, not exact-head evidence); mutants red against the pinned expectations in the integration test; one green pnpm test:stack on the final head; exact-head VPS pnpm test:docker + pnpm test:deploy
```

## Capabilities

### Modified Capabilities

- `stack-verification`:
  - The Office rewrite lane gains unsaved XLSX and PPTX cases.
  - Each rewrite case asserts whether the close rewrote the saved file.

## Impact

- `platform/test/office-rewrite-stack-fixture.ts` and its integration test, plus `office-rewrite-stand-in.ts` if the stand-in needs the flag.
- `vitest.config.ts`.
- `docs/LOCAL_STACK.md` and `platform/test/README.md`.
- No product code.
