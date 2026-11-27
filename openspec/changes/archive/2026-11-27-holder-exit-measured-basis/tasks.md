## Risk packs

- **Resource limits (selected).** TERM-exit time under load against `EXIT_MS`. Task 1.1 measurement.
- **Not selected:** concurrency, file IO, error handling, public API, config, secrets, release, docs, legacy compatibility. The change touches one test constant and its comment; the script and the assertions are unchanged.

## Must preserve

- `expect(bound).toBe(EXIT_MS)`, and `CASE_TIMEOUT_MS = READY_MS + EXIT_MS + 5_000`.
- `deploy/document-server-net.sh`, `SETTLE_MS`, `READY_MS` and every other file are unchanged.
- The held cases keep their expected results (`held: true, timedOut: false, code: 0, signal: null`). The `settle()` 20 ms poll and the `exitBound` hook are unchanged. A `timedOut: 'exit'` is never tolerated.
- No measurement instrumentation is committed.

## 1. Implementation

- [x] 1.1 Measure TERM-to-exit per held case. Use temporary instrumentation that writes to the session scratchpad, with `EXIT_MS` raised to 30 s only while measuring. Do at least 10 counted runs of the file at start load ≥ 67, and at least 3 at start load ≥ 13 and < 67. A run's band comes from its start load; a run that starts below 13 is discarded. Record the per-case maximum with its code and signal, the start load of each run, and the host OS.
- [x] 1.2 Apply the proposal's fit rule (rules 0–3, on `X = max(M, m)`). An in-band failing sample, or `2 × m > 3000`, stops the work and is reported, not fitted. An out-of-band one leads to outcome 3. Set `EXIT_MS` and rewrite its comment at `:30` with the basis (bands, host, runs, maxima; for outcome 3, the band it holds in and the known limitation). Remove the instrumentation.

## 2. Verification

- [x] 2.1 `pnpm exec vitest run --project integration platform/test/document-server-net-script.integration.test.ts`, `pnpm lint`, `pnpm typecheck`: exit 0.
- [ ] 2.2 Only if `EXIT_MS` changed: 5 consecutive full `pnpm test:integration` runs, each started at load ≥ 13 and < 67, all passing.
- [x] 2.3 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`.

## Acceptance mapping (#741)

- Measurement record at load ≥ 67 (band, host, runs, per-case max) → task 1.1, reported in the PR.
- The `:30-31` comment states a measured basis, or the band it holds in with the in-band value → task 1.2.
- `expect(bound).toBe(EXIT_MS)` kept; `CASE_TIMEOUT_MS` derived by formula → Must preserve.
- If `EXIT_MS` changed, 5 loaded full runs → task 2.2.
