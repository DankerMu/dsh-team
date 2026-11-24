## Risk packs

- **Documentation / migration notes — selected.** The DEPLOY.md statements and the timeout ledger. Tasks 1.1, 1.2.
- **Not selected:**
  - Legacy compatibility: there are no consumers outside `platform/test/`, and the `DOCUMENT_SERVER_NET` and `DS_NAME` exports are kept. The absence of a cycle and knip are still verified in 2.1.
  - Concurrency, file IO, auth and secrets: not touched.
  - Error handling: E only adds an assertion on an existing path.
  - Config and release: no value changes, no dependencies.
  - Schema, public API and CLI: none.

## Acceptance-criteria mapping (#666)

- **AC1** (no undelivered-Office wording; `:212` stays conditional) → 1.1.
- **AC2** (the ledger adds up to 9060 s; every idle per-step bound has a code location; the value is unchanged) → 1.2.
- **AC3** (the fraction comment is accurate) → 1.3.
- **AC4** (one definition for non-assertion uses; `lint:deps`, `dead-code` and `test:integration` pass) → 1.4, 2.1.
- **AC5** (an exactly-once assertion, red before the fix and green after) → 1.5.
- **AC6** (no timeout value changes; nothing skipped or removed) → 2.1.

## Must preserve

- Every timeout and deadline value, including `testTimeout: 9_060_000`.
- Every assertion and config-input literal listed in the proposal, including `platform/src/config.test.ts:415-418`.
- The `DS_NAME` export name. `platform/src/orchestrator/` has no diff.
- Every existing assertion of the E case.
- The value pin `expect(DOCUMENT_SERVER).toBe('dsh-team-documentserver')`, which moves to the net fixture's integration test. The hints test drops the import.
- The sample timestamp.
- The `DOCUMENT_SERVER_NET` export and its importers.
- No new import cycle; `platform/` and `plugins/` boundaries are unchanged.

## 1. Implementation

- [x] 1.1 Rewrite `docs/DEPLOY.md` `:212`, `:275` and `:295` as described in the proposal.
  - Reverse-grep `docs/DEPLOY.md`, `deploy/README.md` and `docs/EMPLOYEE_GUIDE.md` for `尚未|未交付|第 ?18 ?组|上线之前|在那之前|交付之前`. Only non-Office hits may remain, such as `:238`'s 「尚未签结」. `:121` is kept, as described in the proposal.
- [x] 1.2 Rewrite the comment in `vitest.config.ts` as one ledger, as described in the proposal.
  - Verify that each listed idle bound points at its code location, and record those locations in the PR.
  - The value is unchanged.
- [x] 1.3 Fix the fraction comment in `office-hints-stack-fixture.integration.test.ts`.
- [x] 1.4 Consolidate the `DOCUMENT_SERVER` constant into `document-server-net-fixture.ts` and rewire every importer and inline use, as described in the proposal.
- [x] 1.5 Add the exactly-once assertion for E, as described in the proposal.
  - Show it red with `{ cause }` temporarily restored in `stack-browser-fixture.ts:138`; the failure should show two occurrences.
  - Revert, then show it green.

## 2. Verification

- [x] 2.1 Run `pnpm lint` (including `lint:deps`), `pnpm dead-code`, `pnpm typecheck` and `pnpm check`.
  - `git grep "'dsh-team-documentserver'" platform/test` must show one definition, and every other hit must be one of the listed assertion or config-input literals.
  - Record the CI-method line count.
- [x] 2.2 Exact-head local `pnpm test:stack`, with the inventory and volume fence (stack-verification evidence rule).
- [x] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`. The Docker tests' imports change in this PR.
