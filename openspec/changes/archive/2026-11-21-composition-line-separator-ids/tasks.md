## Risk packs

- **Error handling — selected.** The change widens a tolerance; it must stay a whitelist so every non-absent-target warning still fails loud. Tasks 1.1, 1.2.
- **Legacy compatibility — selected.** All existing composition cases, including the non-string-id rejection (`managed-composition.integration.test.ts:243`), pass unchanged. Task 1.2.
- **Not selected:** API/CLI, schema, auth/secrets, config, concurrency, file IO, resources, release (the generated script ships through the unchanged start path), documentation beyond the README line.

## Acceptance-criteria mapping

- AC1 (U+2028 profile / U+2029 home rows tolerated, output identical; red before, green after) → tasks 1.1, 1.2.
- AC2 (U+2028 name mismatch and insert-absent rows still reject) → task 1.2.
- AC3 (existing cases unchanged, incl. :243) → task 1.2.
- AC4 (README and spec consistent) → task 1.3.

## Must preserve

- Bundle-layer warnings still throw unconditionally; only profile/home rows are tolerated, and only the absent-target warning.
- Non-string id rows still reject.
- No change to the reader's output shape or to `platform/src/orchestrator/`.

## 1. Implementation

- [x] 1.1 `platform/src/managed-config/read.ts`: tolerated-warning regex gains the `s` flag (nothing else in the whitelist changes). The regex lives inside the non-raw template literal at `read.ts:20`: only add the flag. `[\s\S]` would emit `[sS]` and a `\u2028` escape would emit a raw line terminator that breaks the generated script; check the emitted text, not only the TypeScript source.
- [x] 1.2 `platform/test/managed-composition.integration.test.ts`: red first — profile row `{ id: 'a\u2028b', disabled: true }` and home row `{ id: 'a\u2029b', disabled: true }` (write the escapes in source, never raw characters) are tolerated with output equal to the composition without them; then regressions — a name mismatch needs an existing target, so the profile first inserts `{ id: 'a\u2028b', name: 'x' }` and a later row `{ id: 'a\u2028b', name: 'y' }` must reject; a `patch insert` row `{ id: 'a\u2028b', insert: [...] }` whose target is absent must reject. Existing cases untouched.
- [x] 1.3 `platform/src/managed-config/README.md:9`: confirm it describes "any string id"; adjust wording only if it does not.

## 2. Verification

- [x] 2.1 Red/green run of the integration file; `openspec validate composition-line-separator-ids --strict --no-interactive`; `pnpm check`.
- [x] 2.2 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, confirmed cleanup.
