## Risk packs

- **Error handling / rollback / partial outputs (selected).** Tasks 1.1, 1.3.
  - A missing registry is not the same as an unreadable or malformed one.
  - Validate first, then print.
  - Callers fail loud.
- **Auth / permissions / secrets (selected).** Task 1.3.
  - No key text appears in the query's own output.
- **Config / project setup (selected).** Task 1.1.
  - The plugin 0.2.0 registry format is pinned. The release writer was verified.
- **Not selected:** product code, concurrency, release.

## Acceptance-criteria mapping (#660)

- **AC1** (one script, used by both fixtures) → 1.1, 1.2.
- **AC2** (real `python3 -I` cases; each case's result stated) → 1.3.
- **AC3** (mutants red at the integration layer, recorded) → 1.4.
- **AC4** (the "half written" comment corrected) → 1.1.
- **AC5** (nothing loosened, skipped or removed; `test:integration`, `lint` and `duplicate-code` pass; exact-head `pnpm test:stack`) → 2.1, 2.2.

## Must preserve

See design.md § Must preserve.

## 1. Implementation

- [x] 1.1 Export `registryKeys(lane, path)` from `office-isolation-stack-fixture.ts`, next to `REGISTRY`. Give it a module-private `REGISTRY_KEYS` script that follows the proposal's contract table, and parse its output strictly. Correct the "half written" comment.
- [x] 1.2 Make `distinctKeys` and `registeredKey` call `registryKeys` and nothing else. `registeredKey` uses `[0] ?? null`. Delete `KEYS`, `keysOf` and `REGISTRY_KEY`.
- [x] 1.3 Add integration cases:
  - The script, run with real `python3 -I`. Capture stdout, stderr and status. Cover each row of the contract table with real 64-hex keys, and state each expected result. The mismatch and unreadable cases assert that stdout is empty, and that stdout+stderr contain no key or path.
  - `registryKeys` strict parsing, once: non-JSON, non-list, a non-string element, an empty string.
  - One propagation case per caller: a rejection passes through and is not counted as zero.
    - `distinctKeys` is tested through the exported `bothOpen`.
    - `registeredKey` is exported for its test; knip treats test files as entry points.
  - The strict-parse error is a fixed message and never includes the raw stdout.
  - The PR notes that the container argv gains `-I`.
- [x] 1.4 Run every mutant in design.md § Required evidence. Each must turn a case red; record the text.

## 2. Verification

- [ ] 2.1 `pnpm lint`, `pnpm typecheck`, `pnpm duplicate-code`, `pnpm check`.
- [ ] 2.2 Exact-head local `pnpm test:stack` passes, with the inventory and volume fence.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`. This is the repository gate for every merge; the PR says so.
