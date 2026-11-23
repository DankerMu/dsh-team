## 1. Implementation

- [x] 1.1 Export `NOTICES` from `office-rewrite-stack-fixture.ts`. `rewriteCase` passes `masked: [NOTICES.saveFailed]` in its `names`, with the typing case's reason comment.
- [x] 1.2 `editIntoForgotten` (`office-forgotten-stack-fixture.ts`) imports `NOTICES` and passes `masked: [NOTICES.saveFailed]` in its `names`.
- [x] 1.3 Stand-in cases through the `vi.mock('./stack-browser-fixture.ts')` seam:
  - rewrite: the `office rewrite clean` session's `names.masked` includes `NOTICES.saveFailed`;
  - forgotten: the `office forgotten edit` session's `names.masked` includes `NOTICES.saveFailed`;
  - each recorded red with its `masked` removed.
- [x] 1.4 `platform/test/README.md:92`: the Agent rewrite (`clean`/`unsaved` screenshots) and forgotten copy (edit session) evidence say the save-error span is masked in every screenshot of the session.

## 2. Verification

- [ ] 2.1 The touched integration files pass three times in a row; `pnpm lint` (incl. `lint:deps`), `pnpm typecheck`, `pnpm dead-code` and `pnpm check` exit 0.
- [ ] 2.2 Exact-head local `pnpm test:stack` passes; `office-forgotten-edit-typed.png` (notice shown on the normal path) shows the masked block, and the rewrite `unsaved` screenshots are inspected.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
