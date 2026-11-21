## Acceptance-criteria mapping

- AC1 (no cross-process timer lower bound) → task 1.1.
- AC2 (waiting still proven by state) → task 1.1 keeps `:101`, `:135`; evidence 2.1 mutant.
- AC3 (`:147`, `:240` `>= 800` and upper bounds unchanged) → task 1.1.
- AC4 (repeated runs under load on macOS; Linux CI) → evidence 2.1, 2.2.

## 1. Implementation

- [x] 1.1 Delete `expect(elapsed).toBeGreaterThanOrEqual(400)` (`:99`) and `expect(elapsed).toBeGreaterThanOrEqual(300)` (`:133`) in `platform/test/browser-driver-settlement.integration.test.ts`; remove `elapsed`/`started` bookkeeping only if nothing else uses it (upper bounds do); nothing else changes.

## 2. Verification

- [x] 2.1 Mutant, on an otherwise idle machine: temporarily make `awaitRegisteredDrivers` return immediately (`settled: true`) and show both cases fail on the retained state assertions (pre-change `:101` process state, `:135` pointer `stopped`; `:100`, `:133` after the deletion), not on `settled` or an upper bound; restore. On macOS, run the file ≥ 10 times while `pnpm check` runs in parallel: no lower-bound failure. `pnpm check`.
- [x] 2.2 CI `pnpm test:integration`; exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy` (required for any `platform/test/` change), confirmed cleanup.
