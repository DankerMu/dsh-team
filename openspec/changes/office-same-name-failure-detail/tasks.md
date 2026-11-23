## 1. Implementation

- [ ] 1.1 Export `scrubbedChain` from `platform/test/stack-browser-fixture.ts`, unchanged.
- [ ] 1.2 In `office-editor-stack-fixture.ts`, add the exported `sameNameFailure(a, other)`, taking the two `PromiseSettledResult`s of `:420-423`. It returns `undefined` when both are fulfilled. Otherwise it returns the `AggregateError` of the rejected reasons, A's first, whose message is `Office editor same-name DOCX failed: ` followed by `A: <chain>` and/or `B: <chain>` joined by `; `, only for rejected sides, `<chain>` = `scrubbedChain(reason)`. `sameNameDocx` (`:424-430`) throws its result when it is defined; the rest of the function is unchanged.
- [ ] 1.3 Integration cases in `office-editor-stack-fixture.integration.test.ts`:
  - in the two #663 cases (both sides fail; with and without B's retirement failing), assert the same-name `AggregateError`'s message names both sides with the scrubbed reason, while the existing leak walk still passes over it;
  - direct cases on `sameNameFailure`: both fulfilled → `undefined`; only B rejected → the message names `B:` only and `errors` holds B's reason alone; only A rejected → `A:` only; a non-Error reason → its chain is `unknown failure`. A one-sided failure cannot be driven through `officeEditorScenario`'s stand-in, because a resolved stand-in session still fails the error allowlist, so the helper is the seam;
  - run each new assertion red against the unchanged message first, then green. Record the runs for the PR.

## 2. Verification

- [ ] 2.1 The touched integration file, then `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [ ] 2.2 Exact-head local `pnpm test:stack`, green.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
- [ ] 2.4 The PR says `Refs #671`, not `Closes`, and reports `retiringOnError`'s fixed message as an out-of-scope finding.
