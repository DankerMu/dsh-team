# Design

## Change surface

- `office-rewrite-stack-fixture.ts`:
  - `rewriteCase`'s `browse` from the Agent turn's return to its end;
  - `noticeFlags`;
  - `RewriteCaseEvidence`;
  - `EXPECTED_REWRITE`;
  - `rewriteFacts` (which carries `arrived` out of the fixed facts).
- Its integration test:
  - the three-flag `unseen`, `REFUSED` and `MEASURED` constants and `measured()` (`:155-157`, `:239-275`);
  - the `:162` print case, which gains `arrived`;
  - the `:283` `it.each`;
  - the new seam cases.
- `vitest.config.ts` (`:49-111`).
- `docs/LOCAL_STACK.md:196`: `config`'s third count becomes "at the end of the quiet window after the save".
- `platform/test/README.md:92`, the Local full stack evidence contract.

## Must preserve

- **Order of the case:** open, key, optional typing, the `open` read, the listing, the pre-turn `shown`, the latch install, the Agent turn, the `rewritten` read, then the post-turn steps.
- **Existing facts keep their values:**
  - `config` stays `{ open: 1, window: 2, saved: 2 }`;
  - `cleared`, `states`, `typed`, `entries`, `allowed`, `sessions` and `forgotten` are unchanged;
  - existing notice flags keep their meaning: `before`, `window` (latched from the install to the window's end) and `saved` (latched until the save landed).
- **Screenshots:** names and order unchanged.
- **The typing case** (`typingBrowse`, `typingCase`, `EXPECTED_TYPING`, `typingFacts`) is unchanged.
- **The forgotten record** and `clearingForgottenOnError` are unchanged.
- **The screenshot mask** stays as it is.
- **No nonce, key or notice text** in the evidence.
- **Limits:** the 800-line file limit and the complexity limits.

## Must add/change

- **The seam: one exported function for the post-turn span.**
  - It covers the span from after the `rewritten` read (`:483`) to the end of `browse`.
  - Signature: `noticeSpan(page, steps)`.
    - `page` is `{ evaluate<R>(expression: string): Promise<R> }`. Playwright's `Page` satisfies it, so stand-ins need one internal `as R` and nothing else.
    - `steps` carries:
      - `fetched` and `open`;
      - `waitSaveFailed: boolean`;
      - `save: () => Promise<Observed>`, which types, saves and polls the read;
      - `afterCleared: () => Promise<void>`, the `entries.saved` listing and the `saved` screenshot;
      - `timeout` (`session.timeout`);
      - `windowMs` (`OBSERVE_MS` in the lane).
  - `NOTICE_LATCH`, `NOTICES_SEEN` and `NOTICES_SHOWN` are exported, so a stand-in tells the expressions apart by identity.
  - `steps` also carries the pre-turn `shown`, and the seam returns the assembled `{ notices, config, arrived, cleared, afterSave }`. Here `notices` is `noticeFlags(shown, latched, atSave, savedLatch, quiet)`, so the tests and `browse` use the same assembly. A test overrides `measured(id, { notices, config, cleared })` with it before `rewriteFacts`.
- **Order inside the seam (normative):**
  1. **Positive wait (A3).** One `heldWithin` call polls every 250 ms, bounded by `timeout`.
     - Its check closure records the first instant, in ms from the seam's start, at which each positive held:
       - `config`: `fetched.config > open`;
       - `saveFailed`: `NOTICES_SEEN.saveFailed === true`, checked only when `waitSaveFailed`.
     - It returns once every awaited positive held, or once the bound has passed.
     - `arrived: { config: ms | null, saveFailed: ms | null }`. A positive that is not awaited is `null`. The clock starts at the seam's start, after the `rewritten` read.
  2. **Negative window.** `delay(windowMs)`, then read `latched` (`NOTICES_SEEN`) and `window` (`fetched.config`).
  3. **`atSave` (A2).** Read `NOTICES_SHOWN`.
  4. `afterSave = await save()`.
  5. **`savedLatch`.** Read `NOTICES_SEEN`. This must happen before the re-install, because it is the existing `saved` flag.
  6. **`cleared`.** `heldWithin(noneShown, timeout)`, as today.
  7. **Quiet window (A1).**
     - Re-install `NOTICE_LATCH` immediately, then run `afterCleared` inside the quiet period, then `delay(windowMs)`.
     - Then read `quiet` (`NOTICES_SEEN`) and `config.saved` (`fetched.config`).
     - If `cleared` is false, the quiet window still runs and is recorded; the facts check fails on `cleared` either way.
     - The re-install is correct: the first observer looks up `window.__dshTeamNotices` globally on every mutation, so both observers write into the new object. The re-install's immediate `check()` latches a notice that is already showing. The two cases never read `NOTICE_TIMES`.
- **Notice flags.**
  - Each notice now carries `{ before, window, atSave, saved, quiet }`. A flag the page did not report counts as seen, as today.
  - `UNSEEN` is all five false. `REFUSED` is `{ before: false, window: true, atSave: true, saved: true, quiet: false }`.
- **Why `atSave` is added rather than redefining `saved`.**
  - The issue suggested redefining `REFUSED.saved` to mean "shown at the instant before the save". This fixture adds `atSave` instead, for two reasons:
    - it removes no existing assertion (#657's shared AC);
    - in the clean case, the cumulative `saved` latch still covers the span from the window's end until the save landed.
- **`rewriteFacts`** carries `arrived` in the evidence and leaves it out of the fixed facts.

## Governing invariant

- **Positives:** a positive condition is awaited up to `session.timeout`, never by a fixed sleep alone.
- **Negatives:** each is asserted over a fixed window after its positive.
- **Unsaved case:** 「保存未写回文件」 is on screen at the instant before the save.
- **After the save:** no notice is seen in the window that starts right after the save's clear.

## Sibling surfaces

- **The typing case.** Its `cleared` (`heldWithin`, `:605`) and its `end` point have the same one-instant shape as A1. The issue scopes A1–A3 to the two `CASES`, so the typing case is unchanged and goes into the PR's out-of-scope findings (and the final report).
- **The forgotten lane's `OBSERVE_MS` settle** (`document-server-forgotten-fixture.ts`) is untouched.
- **Stale comments in the same files, to update:**
  - fixture `:70-71`, `:82-89`, `:200-208`, `:350` ("three flags") and `:679-687`;
  - `vitest.config.ts:104` (margin 8730 s → 8880 s);
  - the integration test's "§60's measured" comment: the new values are predictions, confirmed by the exact-head stack.

## Seams under test

- **Driver.** `noticeSpan` with stand-in pages.
  - The stand-in `evaluate` answers by identity:
    - `NOTICE_LATCH` records an install time;
    - `NOTICES_SEEN` returns what the scripted timeline showed since the last install;
    - `NOTICES_SHOWN` returns what it shows now.
  - The stand-in advances `fetched.config` at scripted times. `windowMs` is short (for example 50 ms), and so is `timeout` (for example 500 ms).
- **What the cases assert.** They take the seam's assembled output, override `measured(id, …)` with it, then run it through `rewriteFacts`. A positive case asserts equality with `EXPECTED_REWRITE[id]`. A rejection asserts `toEqual` against EXPECTED with exactly the fields it changes, not just `not.toEqual`.

## Required evidence

Each mutant below keeps the field and weakens only the mechanism. It is shown red with its case, then green.

- **Positive cases, as measured:**
  - clean: no notice, one refresh;
  - unsaved: 「保存未写回文件」 from the window until the save's `saved`, one refresh.

  Both through the seam give `rewriteFacts === EXPECTED_REWRITE[id]`. They are red under mutant (b): without the re-install, `quiet.saveFailed` is true for unsaved.

- **A1:** the notice returns after the re-install time, while the quiet hold is running. This flips exactly `quiet.<id>` to true.
  - Mutant (a): read `quiet` right after the re-install, without the hold.
  - Mutant (b): read `quiet` without the re-install.
- **A2:** the notice shows in the window but clears before the save. This flips exactly `saveFailed.atSave` to false.
  - Mutant (c): read `atSave` from `NOTICES_SEEN` instead of `NOTICES_SHOWN`.
- **A3:**
  - **Late refresh, after `windowMs` but within `timeout`:** the facts match and `arrived.config` is a number. Mutant (d) is the pre-change fixed delay alone, without the positive wait.
  - **No refresh within `timeout`:** the refresh lands after the negative window and before the quiet window. That changes `config` to `{ open: 1, window: 1, saved: 2 }`, and `arrived.config` is `null`. This also shows that the positive wait times out.
  - **A second refresh inside the negative window:** `config` becomes `{ open: 1, window: 3, saved: 3 }` (the counts only grow).
- **Table rows:** the `:283` `it.each` gains rows for `atSave: false` and `quiet: true`, plus one case proving `rewriteFacts` ignores `arrived`.
- **Stack:** exact-head green, with `atSave`, `quiet` and `arrived` in `stackEvidence.officeRewrite`.
  - The values `atSave.saveFailed: true`, `quiet` all false and `config.saved: 2` are predictions.
  - If the stack shows `config.saved: 3` or a `quiet` notice, that is a product finding to report. It must not be absorbed by moving the read back.

## Non-goals

A4, the typing case, product code, and the plugins.

## Review focus

- The positive wait cannot pass while a positive is missing.
- The quiet window is after `cleared`, inside the page.
- The ledger arithmetic.
