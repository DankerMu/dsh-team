## 1. Implementation

- [ ] 1.1 `stack-browser-fixture.ts`:
  - the exported `DS_UNLOAD_SOURCES` table and `recordedError(message, origin)` (proposal § What Changes, design § Decisions), with a comment naming #671 and the user decision of 2026-11-23;
  - integration cases:
    - each of the five measured sources is allowed and returns `{ unload: '<path>:<line>' }`;
    - an ordinary error returns `{ error }` and a non-error type returns `undefined`;
    - these return `{ error }`: the exact text with a character appended, a truncated text, another origin, version `9.4.1`, an unknown script, a known script at another line, and an empty location URL.
- [ ] 1.2 `StackBrowserEvidence.unloadViolations`:
  - `workbenchSession`'s handler (`:284-286`) routes through `recordedError`;
  - `scrubbedEvidence` maps the list;
  - every evidence literal in the tests is updated;
  - the routing case of design § Seams under test, with the stand-in browser's new message option.
- [ ] 1.3 `openHinted`'s collector (`office-hints-stack-fixture.ts:168-172`) routes through `recordedError` and keeps `error` results only. Add the minimal stand-in page and its two cases (design § Seams under test).
- [ ] 1.4 Evidence:
  - `counted` (`office-editor-stack-fixture.ts:170-173`) gains the `unloadViolations` list;
  - `officeHintsLine` gains it too, and its "never the browser lists" test states the new contract;
  - the read-back `toEqual` (`:501-504`) expects `unloadViolations: []`;
  - the editor, rewrite, idle and external line tests (`office-external-stack-fixture.integration.test.ts:255` among them) expect the list.
- [ ] 1.5 Mutants (a)–(f) of design § Required evidence: each red, then reverted. Record each for the PR.
- [ ] 1.6 Docs: `platform/test/README.md:92` and `docs/LOCAL_STACK.md`'s Office rows state the allowance, its sources and the decision.

## 2. Verification

- [ ] 2.1 The touched integration files, then `pnpm lint`, `pnpm typecheck` and `pnpm check`. If the diff exceeds 400 lines, apply `diff-limit-exempt` before pushing the frozen head.
- [ ] 2.2 Exact-head local `pnpm test:stack` (Playwright 1.63), green, with every `unloadViolations` empty.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
- [ ] 2.4 The PR says `Refs #671`. #671 closes once #670 runs `pnpm test:stack` green on Playwright 1.65.
