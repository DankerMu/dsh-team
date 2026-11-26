## Risk packs

- **Concurrency / shared state / ordering (selected).** The owner exits between writing `result.json` and cleanup; frozen owner. Rows 1–4.
- **File IO (selected).** `result.json` read and validated under a frozen owner. Rows 1, 2.
- **Error handling (selected).** An unreadable or invalid result keeps `no command started`. Row 2.
- **Legacy compatibility (selected).** Existing rows and `:315`, `:525` assertions. Task 2.1.
- **Not selected:**
  - Public API / CLI, config, schema, secrets: test fixture only; no format change.
  - Resource limits, release, docs: none.

## Must preserve

See `design.md` § Must preserve.

## 1. Implementation

Write each row first and record its red output, then change the code.

- [x] 1.1 Rows 1–4 in the `claims an uncaptured owner` table (design § Required evidence). Row 1 red before; rows 2–4 green both. Row 2 is split into an unsettled result and a result of another invocation (five rows).
- [x] 1.2 `boundCommand`: on a stopped owner whose scan returns a clean `none`, `settledResult` decides `finished`.
- [x] 1.3 Update the comments the fix makes wrong (design § Must add/change): `settledResult` and `boundCommand` docstrings, `boundCommand`'s inline comment, `lateFinish`'s comment.

## 2. Verification

- [x] 2.1 `pnpm exec vitest run --project integration platform/test/trusted-docker-uncaptured-fixture.integration.test.ts`, `pnpm test:integration`, `pnpm lint`, `pnpm typecheck`, `pnpm dead-code`, `pnpm duplicate-code`: exit 0.
- [ ] 2.2 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`.
