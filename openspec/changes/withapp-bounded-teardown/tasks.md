## Risk packs

- **Concurrency / shared state / ordering (selected).** avvio's serial close queue; abandoned close still queued; failure ordering. Probes A, B; case D.
- **Error handling (selected).** Failure composition, primary first, no swallowing. Cases C, D; probe B.
- **Resource limits (selected).** `TEARDOWN_CLOSE_MS` against the 5 s default budget under load. Task 1.3 measurement; task 2.2 loaded runs.
- **Legacy compatibility (selected).** 40 test files through `withApp` and its wrappers. Task 2.1 full integration; case C.
- **Not selected:**
  - Public API / CLI, config, schema, auth: test fixtures only.
  - File IO: the SQLite handle stays in-memory; leak documented, not fixed.
  - Release, docs: no packaging or documentation surface.

## Must preserve

See `design.md` § Must preserve.

## 1. Implementation

Write each probe first and record its red output, then change the code.

- [ ] 1.1 Probe A in `ragflow-proxy-auth.integration.test.ts` (probe-only `ProxyOptions` field); probe B and cases C, D in the new `platform/test/auth-fixture.integration.test.ts`. All committed; hooks released after assertions. Record red for A, B, D before the code change (C is preserved, green both).
- [ ] 1.2 Move `boundedStep`/`untilAborted` into `auth-fixture.ts` and update their import sites; `withApp` `options.teardownDeadline`, bounded teardown, failure composition (append + same object); local `withProxy` forwards `teardownDeadline`; close-abort case passes `teardownDeadline = deadline + APP_MS / 2`; comments at `:234`, `:341` corrected.
- [ ] 1.3 Measure `withApp`'s close durations under load (≥ 13, < 67) with temporary instrumentation writing to the session scratchpad; set `TEARDOWN_CLOSE_MS` = max × 2 rounded up to 50 ms, ≤ 500 ms (else stop and report); basis in its comment; instrumentation removed before commit.

## 2. Verification

- [ ] 2.1 Touched files, then `pnpm test:integration`, `pnpm lint`, `pnpm typecheck`, `pnpm dead-code`, `pnpm duplicate-code`, `pnpm lint:tests`: exit 0.
- [ ] 2.2 5 consecutive full `pnpm test:integration` runs at 1-minute load ≥ 13 and < 67 (bounded `yes` generators, confirmed gone afterwards): all pass.
- [ ] 2.3 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`.

## Acceptance mapping (#736)

- Red probe: close-abort with a never-resolving `onClose` fails with `close-abort: application close:` plus the teardown close, with no `Test timed out` and no unhandled rejection → probe A (task 1.1).
- Red probe: `run` succeeds, the teardown close hangs, and the case fails with `teardown: application close: …` → probe B (task 1.1).
- Comments at `:234` and `:341` match the real guarantee → task 1.2.
- 5 consecutive full `pnpm test:integration` runs at load ≥ 13 and < 67 → task 2.2.
- `pnpm lint`, `pnpm typecheck`, `pnpm dead-code`, `pnpm duplicate-code` pass, with one bounded-close implementation → task 2.1 and design § Must preserve (`boundedStep`/`untilAborted` only, moved, not copied).
