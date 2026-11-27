# The holder script's TERM-exit bound gets a measured basis

## Why

Issue #741 (from #719 row 6). Line numbers are for main `46c07e9`.

- `platform/test/document-server-net-script.integration.test.ts:30-31` sets `EXIT_MS = 3_000`. Its only justification is the comment "the TERM trap exits within milliseconds of it", which records no measurement. By contrast, `SETTLE_MS` (`:26`) states "measured at load ~6".
- `CASE_TIMEOUT_MS = READY_MS + EXIT_MS + 5_000` (`:33`) is derived from it.
- Once a case is held, `holder()` sends SIGTERM and polls until `termAt + EXIT_MS` (`:92-97`); an overdue process is reported as `timedOut: 'exit'`.
- At a 1-minute load of about 80, the slow-marker case "gives the TERM exit its full bound after a slow marker" (`:167-189`) failed once with `timedOut: 'exit'` and `code: null` (#719 run record, not reproduced here).
- PR #727 explicitly did not measure this row above load 67. The #687/#719 acceptance band is load < 67, and no failure has been seen inside it.
- The failure is attributable, so the risk is a false red, never a false green.

## What Changes

Measure first, then choose one of three outcomes with a fixed rule. Nothing is invented.

- **Measurement.** This is temporary instrumentation and is removed before commit.
  - In `holder()`, for held cases only, record `Date.now() - termAt` at the child's `exit` event, together with its `code` and `signal`. Append one line per sample to a file in the session scratchpad, outside the repository. A sample line has the case name, ms, code, signal, and the run's start load.
  - **Band assignment.** A run's band is the 1-minute load read immediately before the run starts. All of the run's samples count toward that band. A run whose start load is outside both bands (below 13) is discarded and re-run, not counted.
  - For the measurement only, `EXIT_MS` is raised to 30 s, so a slow exit is observed rather than cut.
  - **Out-of-band runs:** at least 10 runs of this file alone, at 1-minute load ≥ 67, with bounded `yes` generators.
  - **In-band runs:** at least 3 runs at load ≥ 13 and < 67.
  - Generators are confirmed gone after each batch.
- **Fit rule.** Let `M` be the out-of-band maximum, `m` the in-band maximum, and `X = max(M, m)`. 0. A failing sample is one that did not exit by itself within the 30 s measurement bound, or ended other than `code: 0`.
  - If it came from an in-band run, stop and report it for a new issue. It is a holder defect inside the acceptance band, out of scope here, and no deadline value fixes it.
  - If it came from an out-of-band run, go straight to outcome 3.
  - Before any outcome is picked: if `2 × m > 3000`, stop and report it the same way as an in-band failure. Outcome 3 is then reachable only because of `M`.
  1. If `2 × X ≤ 3000`: keep `EXIT_MS = 3_000`. The comment states both bands, the host, the runs and both maxima.
  2. Else if `2 × X ≤ 10000`: set `EXIT_MS` to `2 × X`, rounded up to 500 ms, so that `CASE_TIMEOUT_MS` follows by formula. The comment states the basis. Then run the 5-run acceptance band (below).
  3. Else (including an out-of-band rule-0 failure): keep `EXIT_MS = 3_000`. The comment states that it holds only below load 67, with `m` and the band, and records the out-of-band maximum as a known limitation.
- **Unchanged:**
  - `expect(bound).toBe(EXIT_MS)` and `CASE_TIMEOUT_MS`'s formula;
  - `deploy/document-server-net.sh`;
  - `SETTLE_MS` and `READY_MS`;
  - every other file.

`design.md` is omitted: compact level. The change is one test constant and its comment, and the outcome is chosen by the fixed rule above.

## Result

The measurement landed on outcome 1. The maximum was 2 ms over 3 runs at load 14.6–19.9, and 7 ms over 12 runs at load 67.3–99.6. No sample failed. `EXIT_MS` stays at 3 s, and only its comment changes.

A verification run at idle load 6.72 failed the slow-marker case with `timedOut: 'exit'`, the same failure shape as #719. That run was not a measurement sample. The investigation showed a lost first SIGTERM in macOS bash 3.2 (`/bin/sh`), which no deadline value fixes. It is filed as #752, and the comment points to it.

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent (override: none upstream; compact because the change is one test constant and its comment)
Blast radius: the 3 held cases (:111-126, :128-143, :167-189) in document-server-net-script.integration.test.ts; CASE_TIMEOUT_MS follows
Selected risk packs: Resource limits (deadline under load)
Evidence floor: measurement record (bands, host, runs, per-case max); the file's cases pass; if EXIT_MS changes, 5 consecutive full pnpm test:integration runs at load >= 13 and < 67; pnpm lint
```

## Capabilities

### Modified Capabilities

- `integration-test-budgets`: the holder script's TERM-exit deadline carries a measured basis or states the load band in which it holds.

## Impact

- `platform/test/document-server-net-script.integration.test.ts` (a constant and its comment).
