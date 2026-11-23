## 1. Implementation

- [ ] 1.1 Export `scrubbedChain` from `platform/test/stack-browser-fixture.ts`, unchanged.
- [ ] 1.2 In `office-editor-stack-fixture.ts`, in three steps:
  - (a) Refactor only: add the exported `sameNameFailure(a, other)`, taking the two `PromiseSettledResult`s of `:421-424`. It returns `undefined` when both are fulfilled, otherwise the `AggregateError` of the rejected reasons, A's first, with today's message `Office editor same-name DOCX failed`. `sameNameDocx` (`:425-430`) throws its result when it is defined; the rest of the function is unchanged. The existing cases stay green.
  - (b) Write the new assertions of 1.3; the message assertions are red.
  - (c) Change the message to `Office editor same-name DOCX failed: ` followed by `A: <chain>` and/or `B: <chain>` joined by `; `, only for rejected sides, `<chain>` = `scrubbedChain(reason)`. The assertions turn green.
- [ ] 1.3 Integration cases in `office-editor-stack-fixture.integration.test.ts`:
  - in the two #663 cases (both sides fail; with and without B's retirement failing), assert the same-name `AggregateError`'s message names both sides with the scrubbed reason, while the existing leak walk still passes over it;
  - direct cases on `sameNameFailure`: both fulfilled → `undefined`; only B rejected → the message names `B:` only and `errors` holds B's reason alone; only A rejected → `A:` only; a non-Error reason → its chain is `unknown failure`. A one-sided failure cannot be driven through `officeEditorScenario`'s stand-in: the mocked `workbenchSession` never runs `body`, so a resolved side has no save and fails at `Office editor save not observed` (`:357-359`). The helper is the seam. The `undefined` and `errors` assertions are characterisation: green in both phases;
  - run each message assertion red after step (a), then green after step (c). Record the runs for the PR.

## 2. Verification

- [ ] 2.1 The touched integration file, then `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [ ] 2.2 Exact-head local `pnpm test:stack`, green.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
- [ ] 2.4 The PR says `Refs #671`, not `Closes`, and reports as out-of-scope findings the two nested `AggregateError` paths that still hide the reason (proposal § Acceptance-criteria mapping).
