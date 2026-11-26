# withApp bounds its teardown close and keeps the primary failure first

## Why

Issue #736, left over from #719 slice 1 (PR #727). Line numbers refer to main `ae20810`.

- `withApp` (`platform/test/auth-fixture.ts:125-170`) ends with `finally { … await app.close(); }` (`:167`). That close has no bound and does not know whether the case already abandoned a close.
- The close-abort case (`ragflow-proxy-auth.integration.test.ts:343-375`) bounds its own close: `boundedStep('close-abort: application close', deadline, (signal) => untilAborted(app.close(), signal))`. `untilAborted` (`auth-tcp-fixture.ts:135-150`) cuts the wait only; the close keeps running.
- Fastify 5's `close` runs on avvio's close queue, a fastq with concurrency 1. `onClose` hooks sit at its head, and each `close()` callback is pushed behind them. One `onClose` that never settles stops the queue, so neither the case's close nor `withApp`'s teardown close ever settles.
- The named step error (`close-abort: application close: TimeoutError…`) therefore reaches `withApp`'s `finally`, which waits forever. vitest reports an unattributed `Test timed out` at `CASE_MS` (22 s), and the named error is lost. #719 required exactly the opposite ("失败信息里带 phase，不是 vitest 的 `Test timed out`").
- The comments at `:234` ("the last close stays inside") and `:341` ("the teardown close stays inside") hold only for a close that finishes. #727's probe a4 released its hook before teardown for that reason (`openspec/changes/archive/2026-11-25-integration-tail-site-deadlines/tasks.md`).

## What Changes

Maintainer decision (2026-11-26, session): the caller passes a deadline; when it passes none, a measured default bounds the close. Fixture review round 1 settled the rest.

- **`withApp` gains `options.teardownDeadline?: number`**, a `performance.now()` deadline of its own. It is not the case's step deadline: reusing that would make `boundedStep` throw `case deadline passed before it started` without ever calling `app.close()`, which leaves a healthy app unclosed. The teardown runs `boundedStep('teardown: application close', teardownDeadline ?? performance.now() + TEARDOWN_CLOSE_MS, (signal) => untilAborted(app.close(), signal))`. The `app === undefined` path (`database.close()`) is unchanged.
- **One implementation, no import cycle.** `auth-tcp-fixture.ts` and `gateway-http-fixture.ts` import `withApp` from `auth-fixture.ts`, so `withApp` cannot import from them (`.dependency-cruiser.cjs` `no-circular` covers `platform/test`). `boundedStep` and `untilAborted` move into `auth-fixture.ts`, unchanged. Their import sites are updated: `auth-tcp-fixture.ts`, `login-throttle.integration.test.ts`, `instance-lifecycle.integration.test.ts`, `ragflow-proxy-auth.integration.test.ts`. `auth-tcp-fixture.ts` may re-export them only if a consumer needs that; otherwise it does not.
- **Failure composition.** This follows the #722/#662 `withCleanup` precedent (`verify-browser-runtime.integration.test.ts:186-204`), never an `AggregateError`: vitest prints only an aggregate's members (`gateway-stream-fixture.ts:682`).
  - `run` failed with an `Error` and teardown failed: the same error object is rethrown, with `; teardown: application close: <reason>` appended to its `message`. The primary stays first.
  - `run` failed with a non-`Error` value and teardown failed: the value is rethrown unchanged, and the teardown reason is lost, as in the precedent.
  - `run` succeeded and teardown failed: the `teardown: application close: …` error from `boundedStep` is thrown.
  - `run` failed and teardown succeeded: the same object is rethrown unchanged.
- **`TEARDOWN_CLOSE_MS`** is measured, with an explicit fit rule.
  - **Measurement.** Temporary instrumentation in `withApp` appends one `performance.now()` close duration per teardown to a file in the session scratchpad, outside the repository. Full `pnpm test:integration` runs at 1-minute load ≥ 13 and < 67 supply the count and the maximum. The instrumentation is removed before commit.
  - **Fit rule.** `TEARDOWN_CLOSE_MS` is the measured max × 2, rounded up to 50 ms. The max is taken over **both** lanes that use `withApp`: `pnpm test:integration`, and `pnpm test`, whose 38 unit files under `platform/src/` also use it. The implementation run found that the unit lane's healthy closes reach 485.7 ms under load (`platform/src/admin/empty-body.test.ts`), against 66.1 ms in the integration lane. A healthy close must never turn a case red, so that rule takes precedence over the earlier ≤ 500 ms target.
  - **Accepted cost.** A default-budget case that has already spent `HTTP_SEND_MS + HTTP_OBSERVATION_MS` = 4500 ms of its 5000 ms `testTimeout` (`gateway-http-fixture.ts:19-30`) and then hangs in its close may hit the runner timeout before the teardown reports. That happens only on a hung close, and it is the same behavior as today. A case that needs the attribution passes `teardownDeadline`.
  - The basis is written beside the constant: load band, host OS, runs, count, max.
- **Wrappers.** `withListeningApp` already forwards `withApp`'s whole `options`, so it is unchanged. The file-local `withProxy` in `ragflow-proxy-auth.integration.test.ts:80` gains `teardownDeadline` in its `ProxyOptions` and forwards it. `withForwardingApp` and `ragflow-proxy-fixture.ts`'s `withProxy` have no caller that passes a deadline, so they are unchanged.
- **The close-abort case.** It takes `start = performance.now()` before `withProxy`. The steps' `deadline` is `start + CASE_MS - APP_MS`, as today. `teardownDeadline` is `deadline + APP_MS / 2`: half of the reserved app window goes to the close, and the other half covers the report before the runner's `CASE_MS`. The comments at `:234` and `:341` are corrected to say this.
- **The leaked close.** After an abandoned close, the hung `app.close()` and its SQLite handle (`app.ts` `onClose`) stay in the worker. A case in that state always fails and never silently continues, and the code comment says so. The committed probes release their hung hook after their assertions, so the queued closes settle.

## Triage

```text
Issue type: test-infrastructure bugfix (failure attribution)
Fixture level: expanded
Upstream suggested level: absent (shared fixture used by 40 test files; teardown ordering)
Blast radius: every integration test using withApp, withListeningApp, withForwardingApp or withProxy; a wrong bound turns healthy teardowns red under load
Selected risk packs: Concurrency / shared state / ordering; Error handling; Resource limits; Legacy compatibility
Evidence floor: red probes (hung onClose → named step error, not Test timed out; run ok + hung teardown → teardown error); measured TEARDOWN_CLOSE_MS; 5 consecutive full pnpm test:integration runs at 1-minute load ≥ 13 and < 67; lint, typecheck, dead-code, duplicate-code; exact-head VPS pnpm test:docker + pnpm test:deploy
```

## Capabilities

### Modified Capabilities

- `integration-test-budgets`: the close-abort case fails with its named step even when the close never finishes; `withApp`'s teardown close is bounded and never replaces the case's failure.

## Impact

- `platform/test/auth-fixture.ts`, `auth-tcp-fixture.ts`, `login-throttle.integration.test.ts`, `instance-lifecycle.integration.test.ts`, `ragflow-proxy-auth.integration.test.ts`, and a new `platform/test/auth-fixture.integration.test.ts` (probe B, cases C and D).
- Out of scope: #719 slice 2 (`sendHttp`, `observeHttp`, already merged); case-body bare `await app.close()` in `admin-model-connection.integration.test.ts:393` and `admin-ragflow-connection.integration.test.ts:290` (another defect class, recorded in the issue); the sibling `finally { await app.close() }` in `cli-process-fixture.ts:271-276` and `admin-runtime-config.integration.test.ts:396-398` (not through `withApp`; not converged here).
