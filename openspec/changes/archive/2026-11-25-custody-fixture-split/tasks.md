## Risk packs

- **Legacy compatibility — selected.** Every existing case must still run, with the same title, the same body and the same total count. Task 2.1 compares the reporter's case list before and after.
- **Not selected:**
  - API and config: test code only.
  - Error handling: no logic changes.
  - Resource limits, release, docs: none apply.
- **Concurrency / ordering — selected.** Moving the deadline cases into their own file changes scheduling. They used to run serially after the other custody cases; now they run on a separate worker, in parallel with those cases. The custody cases share no fixture lock (`lock-unavailable` is only a tested mode), and each uses private temp roots. Their budgets were measured under load in #687. Evidence: one full `pnpm test:integration` with no deadline case cut (task 2.1).

## Acceptance mapping (#718 item 4)

- Both files are split by responsibility with headroom, and `pnpm lint` passes: tasks 1.1–1.4, 2.1. Slice 2 gets function headroom from task 1.2.

## Must preserve

- Every case title and body is unchanged. The suite keeps the same number of integration tests: same files run in total, plus one new file.
- Every moved symbol has exactly one definition. There are no re-export shims and no duplicated helper.
- Exported behavior of `caseBudget` and `caseSpawn`, including the messages they produce, is byte-identical.

## 1. Implementation

- [x] 1.1 Create `case-budget-fixture.ts` and `trusted-docker-process-fixture.ts` with exactly the symbols listed in proposal § What Changes. Update every importer.
- [x] 1.2 Extract the `createTrustedDockerFixture` cleanup closure into a module-level function, unchanged.
- [x] 1.3 Create `trusted-docker-custody-fixture.ts` with the shared helpers. Move the listed cases and their exclusive helpers to `trusted-docker-deadline.integration.test.ts`, which calls `vi.setConfig({ testTimeout: CASE_MS })`.
- [x] 1.4 Check headroom on every touched and new file:
  - Run `pnpm exec eslint --rule '{"max-lines":["error",{"max":700,"skipBlankLines":true,"skipComments":true}]}' <files>`.
  - Confirm `createTrustedDockerFixture` is now well below 200 effective lines.

## 2. Verification

- [x] 2.1 Before and after, run `pnpm exec vitest list --project integration --json=<scratch file>`; it must exit 0, so a broken import fails collection.
  - **Case list:** diff the sorted case names and the count. Only the file may change.
  - **Moved blocks:** `git diff --color-moved=zebra --color-moved-ws=allow-indentation-change` shows that case bodies and helpers moved verbatim.
  - **Single definition:** grep each moved symbol and confirm it is defined once in the repo. `jscpd` ignores `*.test.ts`, so this is the only duplicate check covering the test files.
  - **Full suites:** `pnpm test:integration` passes with no deadline case cut. Also run `pnpm lint`, `pnpm typecheck`, `pnpm fmt:check`, `pnpm dead-code`, `pnpm duplicate-code` and `pnpm lint:deps`.
- [x] 2.2 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
