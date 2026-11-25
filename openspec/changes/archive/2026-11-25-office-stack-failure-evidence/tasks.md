## Risk packs

- **Error handling (selected).**
  - Double failures become plain errors with folded scrubbed chains.
  - EPIPE is contained.
  - The renderer is total.
  - Tasks 1.1 and 1.2.
- **Security (selected).**
  - No thrown error, and none of its own properties, `cause` or `errors`, holds unscrubbed text. This is checked through `everythingPrinted`.
  - `kA` and the external lane's JWT secret stay absent.
  - Task 1.1.
- **Legacy compatibility (selected).** The existing redaction, fold-once and mask scenarios still pass, the workbench failure class and its evidence are unchanged, and the evidence line only gains a field. Tasks 1.1, 1.3 and 2.1.
- **Not selected:** schema, auth, concurrency, resources, release and docs.

## Acceptance mapping (#717)

- **Items 1–3.** A constructed double failure's report shows both scrubbed reasons and nothing raw (task 1.1).
- **Item 4.** A close-only failure is scrubbed (task 1.1).
- **Item 5.** The single file's vitest rc is 0 (task 1.2).
- **Item 6.** Forgotten evidence lists its sources (task 1.3).
- **Item 7.** A masked session on a non-Chinese page fails with no screenshot (task 1.4).
- **Item 8.** Both mutants are red (task 1.5).
- **Overall.** `pnpm test:integration` and `pnpm test:stack` pass (task 2).

## Must preserve

- **Existing scenarios.** Every scenario of `stack-verification`'s "Stack workbench failures carry no document key or query", "A stack session failure folds each cause once" and "Office session screenshots mask the save-error notice" still passes.
- **One scrub implementation.**
- **Session plus close.**
  - It stays a `StackWorkbenchFailure` with its prefix and its scrubbed `evidence`.
  - `sessionFailure` still reads the lists through `instanceof StackWorkbenchFailure`.
  - This is the existing test at `stack-browser-fixture.integration.test.ts:344-367`, updated only for the folded close reason.
- **Forgotten scrubbing.** It still passes `kA`.
- **External lane.** Its JWT secret stays absent (`office-external-stack-fixture.integration.test.ts:292,365,385`). Those assertions must cover the folded message.
- **Same-name editor case.** Each reason prints once (`office-editor-stack-fixture.integration.test.ts:448`; message pinned).

## 1. Implementation

Write each case first and record its red output, then change the code.

- [x] 1.1 Scrubbed chain and plain double failures.
  - **Code:**
    - Extend `scrubbedChain`: expand aggregate members, bound each branch at 8, use a total non-`Error` renderer.
    - Delete `sessionFailure`'s own loop.
    - `retiringOnError` throws a plain `Error` (fixed text plus scrubbed chain; no `cause`, no `errors`).
    - The workbench session-plus-close failure stays a `StackWorkbenchFailure` with the close reason folded in.
    - A close-only failure becomes a scrubbed plain `Error`.
  - **Cases** (each member carries a 64-hex `/doc/<key>/c/?x` text; each asserts `not.toBeInstanceOf(AggregateError)`, both scrubbed reasons in the message, and `everythingPrinted` free of the raw text):
    - editor, forgotten, external and idle lane-plus-retire;
    - workbench session-plus-close (still a `StackWorkbenchFailure`, evidence intact);
    - forgotten workbench session-plus-close through `sessionFailure` (lists present, `kA` absent);
    - close-only;
    - same-name editor plus retire (exact message, each reason once).
  - **Updates:** the tests that asserted raw `.errors`, and the `unknown failure` expectation at `office-editor-stack-fixture.integration.test.ts:493`.
- [x] 1.2 One shared stdin runner (non-test module plus sibling test) replaces both `local` runners.
  - It ignores only `EPIPE` and rejects any other stdin error.
  - Evidence: a child that never reads 8 MB of input. The file's vitest rc goes from 1 (uncaught `write EPIPE`) to 0.
  - A non-EPIPE stdin error rejects.
- [x] 1.3 `OfficeForgottenEvidence.unloadViolations: { edit; recover }` via `scrubEach`.
  - Prove it with a pure assembler or a success-path mock: a non-empty source appears scrubbed.
  - The existing tests reach only the edit session.
- [x] 1.4 Locale wait in `workbenchSession` for masked sessions (after `ready()`, before `body`, bounded `until`).
  - A locale failure skips the failure screenshot.
  - Case: call `workbenchSession` directly with `masked` set and no `login` (`converseInWorkbench` sets `login` and no mask, so it cannot be used). A stub page with `lang="en"` fails with a named reason and takes zero screenshots, and `zh-CN` proceeds. Every existing stub that sets `masked` must answer the `lang` read.
- [x] 1.5 Mutants and dead code.
  - Add the prefixed `DS_SCRIPT` counterexample and the `scrubbedEvidence` `not.toBe` assertion; show each mutant red.
  - Delete the `isAbsentResource` branch, its import and its test.

## 2. Verification

- [x] 2.1 Record each red before the change and green after. Run `pnpm test:integration`, `pnpm lint`, `pnpm typecheck`, `pnpm dead-code` and `pnpm duplicate-code`.
- [x] 2.2 Run one local `pnpm test:stack` on the final head (locale wait passes on real DSH; forgotten evidence line has the new field). Then run the exact-head trusted VPS `pnpm test:docker` and `pnpm test:deploy`.
