# Design

Change surface: `withApp` teardown (`platform/test/auth-fixture.ts:125-170`); `boundedStep`/`untilAborted` moved into `auth-fixture.ts` (import sites updated); the file-local `withProxy`, the close-abort case and comments in `ragflow-proxy-auth.integration.test.ts`; new `auth-fixture.integration.test.ts`.

Must preserve:

- `withApp`'s positional signature `(run, cookieSecure, trustedProxies, resolveUpstream, options)`; every existing caller compiles and behaves the same when its close finishes.
- `run` failure with a healthy teardown: the same error object is rethrown (`rejects.toBe` style assertions keep passing).
- `app === undefined` (build failure): `database.close()` only, as today.
- The existing close-abort assertions (fixed 500, upstream socket closed, measured `CLOSE_ABORT_MS`) and the other `ragflow-proxy-auth` cases.
- `boundedStep`/`untilAborted` semantics unchanged; no second bounding implementation.

Must add/change:

- `options.teardownDeadline?: number` on `withApp` and the local `withProxy`'s `ProxyOptions`.
- Bounded teardown close via `boundedStep('teardown: application close', …)` and `untilAborted`, both now in `auth-fixture.ts`.
- Failure composition per proposal (append to the primary `Error`'s message, rethrow the same object; no `AggregateError`).
- `TEARDOWN_CLOSE_MS` measured, with its basis in a comment.

Governing invariant: a case using `withApp` always settles before its runner timeout with a message that names the first failing phase; a teardown failure is reported but never replaces an earlier failure.

Sibling surfaces:

- `withListeningApp` (`auth-tcp-fixture.ts:68`): already forwards `options` whole; unchanged.
- `withForwardingApp` (`gateway-http-fixture.ts:129`), `withProxy` (`ragflow-proxy-fixture.ts:56`): no caller passes a deadline; unchanged (they get the measured default).
- File-local `withProxy` (`ragflow-proxy-auth.integration.test.ts:80`): forwards `teardownDeadline`.
- `cli-process-fixture.ts:271-276`, `admin-runtime-config.integration.test.ts:396-398`: same teardown shape outside `withApp`; non-goal (not converged).
- `admin-model-connection.integration.test.ts:393`, `admin-ragflow-connection.integration.test.ts:290`: bare case-body close; non-goal.
- `app.ts` `onClose` (SQLite close, `flushActivity`, `instanceService.close()`): production hooks whose hang this change makes attributable; unchanged.

Seams under test: `withApp` directly in the new `platform/test/auth-fixture.integration.test.ts` (probe B, cases C and D); a separate committed probe case in `ragflow-proxy-auth.integration.test.ts` for probe A, which installs its never-resolving `onClose` through a probe-only `ProxyOptions` field, so no other case in the file is affected. All probes are committed permanently, and each releases its hung hook after its assertions.

Required evidence:

- **Probe A** (red before): the local `withProxy` with a never-resolving `onClose` registered before `listen`, running the close-abort flow with a short budget of its own: `start`, steps `deadline = start + 2 × APP_MS`, `teardownDeadline = deadline + APP_MS / 2`. That costs about 5 s, not 20 s. Expected: the case's rejection `message` starts with `close-abort: application close:` and contains `; teardown: application close:`. It settles before `deadline + APP_MS`. The file's run shows no `Test timed out` and no unhandled rejection. Before: `Test timed out`. The hook is released afterwards.
- **Probe B** (red before): `run` succeeds, an `onClose` hook never resolves, and no `teardownDeadline` is passed. Expected: rejects with a `message` starting `teardown: application close:`, within `TEARDOWN_CLOSE_MS + 1000` ms of `run`'s end. Before: the runner timeout at 5 s. The hook is released afterwards.
- **Case C** (preserved; green before and after): `run` throws `E` and the teardown is healthy. It rejects with `E` itself (`toBe(E)`), and `E.message` is unchanged.
- **Cases E′ and frozen** (review round 1; red before): a `DOMException` primary gets the teardown appended as an own `message`; a frozen `Error` primary is rethrown unchanged.
- **Case D** (red before): `run` throws `E` and the teardown hangs. It rejects with `E` itself, and `E.message` equals the original message followed by `; teardown: application close: ` and the reason.
- **Measurement:** count and max of `withApp` close durations from full `pnpm test:integration` runs and full `pnpm test` runs at load ≥ 13 and < 67, recorded in the PR and beside the constant. `TEARDOWN_CLOSE_MS` = max over both lanes × 2, rounded up to 50 ms; healthy closes never turn red (accepted cost in proposal).
- **5 consecutive full `pnpm test:integration` runs**, each started at 1-minute load ≥ 13 and < 67, using bounded `yes` generators that are confirmed gone afterwards. All pass.
- `pnpm lint` (includes `no-circular`), `pnpm typecheck`, `pnpm dead-code`, `pnpm duplicate-code`, `pnpm lint:tests`: exit 0.

Non-goals: converging the sibling teardowns outside `withApp`; bounding case-body bare closes; releasing the hung close or its SQLite handle.

Review focus:

- The primary failure stays first in every composition; no swallowed error; no `AggregateError`.
- The teardown deadline is never the step deadline, so a stalled step still closes a healthy app.
- No import cycle (`boundedStep`/`untilAborted` live in `auth-fixture.ts`).
- `TEARDOWN_CLOSE_MS` has a measured basis over both lanes; no healthy close can exceed it under the measured load band.
- A hung close cannot leak into a passing case.
- Wrappers forward `deadline` without changing their other behavior.
