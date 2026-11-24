## 1. Implementation

- [ ] 1.1 `stack-browser-fixture.ts`: the exported `DS_UNLOAD_SOURCES` table and `documentServerUnload(text, location, origin)` (proposal § What Changes, design § Decisions), with a comment naming #671 and the user decision of 2026-11-23. Integration cases:
  - each of the five measured sources is allowed and returns `<path>:<line>`;
  - rejected: an altered or prefixed text, another origin, version `9.4.1`, an unknown script, a known script at another line, an empty location URL.
- [ ] 1.2 `StackBrowserEvidence.unloadViolations`. `workbenchSession`'s console handler routes allowed reports there and everything else to `consoleErrors` as today. `scrubbedEvidence` maps the list. Update every evidence literal in the tests.
- [ ] 1.3 `openHinted`'s collector (`office-hints-stack-fixture.ts:168-170`) drops allowed reports through the classifier. Add the stand-in cases of design § Seams under test.
- [ ] 1.4 Evidence lines: `counted` in `office-editor-stack-fixture.ts`, the rewrite session line and the hints line each gain the `unloadViolations` count. Their line tests expect it.
- [ ] 1.5 Mutants (a)–(f) of design § Required evidence: each red, then reverted. Record each for the PR.
- [ ] 1.6 Docs: `platform/test/README.md:92` and `docs/LOCAL_STACK.md`'s Office rows state the allowance, its sources and the decision.

## 2. Verification

- [ ] 2.1 The touched integration files, then `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [ ] 2.2 Exact-head local `pnpm test:stack` (Playwright 1.63), green, with every `unloadViolations` empty.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
- [ ] 2.4 The PR says `Refs #671`. #671 closes once #670 runs `pnpm test:stack` green on Playwright 1.65.
