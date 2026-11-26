## Risk packs

- **Auth / permissions / secrets (selected).** Document keys in failure reports. Tasks 1.1, 1.2, 1.3; `everythingPrinted` assertions.
- **Error handling (selected).** Double-failure shape; single-failure identity. Tasks 1.1, 1.4.
- **Legacy compatibility (selected).** Existing double-failure, workbench and fold-once scenarios; `rejects.toBe(lane)`. Task 2.1.
- **Not selected:**
  - Public API / CLI, config, schema: test fixtures only; no entrypoint or format changes.
  - File IO / path safety: cleanup command unchanged.
  - Concurrency, resources, release, docs: no change in ordering, limits, packaging; no doc mentions this shape.

## Must preserve

See `design.md` § Must preserve.

## 1. Implementation

Write each case first and record its red output, then change the code.

- [x] 1.1 `withWorkFiles` double failure → one plain scrubbed `Error`. Cases per design (with and without a retirement wrapper; keys absent from `everythingPrinted`).
- [x] 1.2 `expectFreeOf` in `stack-browser-fixture.ts`; both forgotten checks (`:454`, `:476`) call it. Cases per design (red with the old body first).
- [x] 1.3 Sweep (#3) of the ten files named in the proposal, actual, expected and message arguments, by the source rule there; change/keep table in the PR description; no-echo cases where a unit seam reaches the site.
- [x] 1.4 Preserved behavior (green before and after, no red expected): lane-only failure through `withWorkFiles` rejects with the same object.

## 2. Verification

- [x] 2.1 The touched integration files, then `pnpm test:integration`, `pnpm lint`, `pnpm typecheck`, `pnpm dead-code`, `pnpm duplicate-code`, `pnpm lint:tests`: exit 0.
- [ ] 2.2 One local `pnpm test:stack` on the final head.
- [ ] 2.3 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`.
