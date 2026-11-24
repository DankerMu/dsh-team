## 1. Implementation

- [x] 1.1 New module `office-rewrite-formats.ts`:
  - move `REWRITER` unchanged;
  - add `PART_REWRITER`, `PARTS`, the per-extension `rewriteArgv` and `rewriteCommand` (design § Must add/change);
  - the exported `freshFile` step;
  - its integration test takes over the existing `REWRITER` and quoting cases and adds the part-rewriter, argv and `freshFile` cases.
- [x] 1.2 Rewrite fixture:
  - `CASES` with `ext` and the `xlsx` / `pptx` cases;
  - `freshFile` replaces `freshDocx`, using the editor fixture's template helper, which is extracted once from `editAndSave`;
  - `typeAndSave` with the case's `ext`;
  - the index type widened;
  - `EXPECTED_REWRITE.xlsx` / `.pptx` = `CLEAN`;
  - evidence type, `officeRewriteLine`, scenario and the configured-scripts check for four cases;
  - comments naming DOCX updated (design § Sibling surfaces).
- [x] 1.3 Rewrite fixture integration test:
  - provider arrays of four;
  - the `ownedRewrites` case expects four scripts;
  - the per-case rows and the print case cover the new cases where they range over cases;
  - no overall growth of the file (design § Must preserve, Limits).
- [x] 1.4 Mutants (a)–(g) of design § Required evidence: each red with its case, then green. Record each run for the PR.
- [x] 1.5 Budget and docs:
  - `vitest.config.ts`: the #657 A4 ledger line (+1970 s), the Sum line, `testTimeout: 12_050_000` and the deadline-only note (design § Budget).
  - `docs/LOCAL_STACK.md:196` and `platform/test/README.md:92`: the two new cases, the stdlib rewrite and their screenshots.
- [x] 1.6 PR:
  - apply `diff-limit-exempt` before pushing the frozen head, if the diff exceeds 400 lines;
  - `Closes #657`;
  - report as an out-of-scope finding the unsaved XLSX/PPTX gap: whether those editors' refreshed-away session sends a status 2 or leaves a forgotten copy.

## 2. Verification

- [x] 2.1 Measuring local `pnpm test:stack` on the implementation commit. `officeRewrite.xlsx` and `.pptx` must equal `CLEAN`; otherwise stop and report to the user (design § Measurement).
- [x] 2.2 `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [x] 2.3 Exact-head local `pnpm test:stack`, green, with the inventory and volume fence passing.
- [x] 2.4 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, with confirmed cleanup.
