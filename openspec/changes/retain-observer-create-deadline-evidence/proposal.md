## Why

#343: on main CI run 40014220568 attempt 1 (head `1dcec98`), `platform/test/deployed-docker-observer.integration.test.ts > settles a compiled child successful mutation and its initialized normal-exit participant` failed in 375ms. The compiled child's non-stall create POST (`deployed-docker-observer-fixture.ts:586`, `AbortSignal.timeout(200)`) was aborted with `DockerTransportError … ABORT_ERR`, the child's `assert.equal(failure,undefined)` (`:593`) failed and it exited 1. Cause UNKNOWN; one occurrence in ~114 attempts.

The failure retained only the child's stderr stack. The test throws at `deployed-docker-observer.integration.test.ts:170`, so the engine fixture's state (`requests`, `persisted`, `markersBeforeBinding`, whether `dispatched` resolved) is never reported, and no time points exist for the child's call, the engine's receipt, or the engine's response.

## What Changes

Diagnostics only, test fixtures only. All time points use `process.hrtime.bigint()` (system-wide CLOCK_MONOTONIC on Linux, `mach_absolute_time` on macOS), so values from the vitest worker and the compiled child are directly comparable on one host. They are reported as milliseconds (`Number(ns) / 1e6`).

- **Engine fixture** (`platform/test/deployed-docker-engine-fixture.ts`), create path only: `received` (request callback; headers already parsed), `bodyEnded` (`end` handler, before dispatch), `responseFinished` (response `finish`: the body was handed to the kernel socket buffer, not proof the child received it) and `responseClosed` (response `close`; an aborting child destroys its socket, which can yield `close` without `finish`). A `dispatchedSettled` flag, and the maximum event-loop delay of the vitest worker over the scenario (`perf_hooks.monitorEventLoopDelay`, enabled for the scenario and disabled afterwards), because `received`/`responseFinished` are observed on that worker's event loop and may be late only because it was blocked. Recording adds no awaits and reorders no handler statements.
- **Child source** (`deployed-docker-observer-fixture.ts`, non-stall branch only): `called` immediately before the call; `issued` immediately after `client.json(...)` returns its pending promise; `settled` in the catch. `trackVerificationDockerClient().json` is `async` (`scripts/verification-submissions.mjs:123-133`), so everything synchronous before its first `await` — `submit()`'s pending-marker write and the original client's synchronous transport setup and request write — has run by `issued`. When the create fails, the child writes one line `create-timing:{"called":…,"issued":…,"settled":…}` to stderr before the unchanged assertion. Success and stall paths write nothing new.
- **Test** (`deployed-docker-observer.integration.test.ts:170`): the assertion message becomes a JSON diagnostic produced by one formatter exported from `deployed-docker-observer-fixture.ts` (kept in an existing module that `platform/test/e2e-engine-fixture.py` already copies). Fields: `childTiming` (parsed from the `create-timing:` line, independent of any tail, or `null`), `engine` (`received`, `bodyEnded`, `responseFinished`, `responseClosed`, `dispatchedSettled`, `persisted`, `markersBeforeBinding.length`, `requests` as `METHOD path` strings, `maxEventLoopDelayMs`), and `stdout`/`stderr` tails (last 8192 characters each, prefixed by `[truncated: <n> earlier characters omitted]` when longer). The criterion `{ code: 0, signal: null }` is unchanged.

What the evidence separates, and what it does not:

- `issued - called` near or above 200ms → the synchronous `submit()` plus the client's synchronous request setup consumed the budget.
- Engine `received` absent, or late relative to `issued`, with a small `maxEventLoopDelayMs` → transport or child-side asynchronous work before the engine saw the request; with a large `maxEventLoopDelayMs` → the worker's scheduling may explain the lateness. These are not further separated.
- `responseFinished` present well before `settled` → the response reached the kernel buffer before the child's abort; delivery or parsing on the child side.
- `settled - called` well above 200ms (for example around 350ms) → the child's own timer fired late, independent evidence that the child's event loop was blocked or starved.

The evidence never names a root cause; an unclassifiable recurrence stays UNKNOWN.

Unchanged: the 200ms deadline (the stall sibling depends on it for real cancellation), every assertion and the request sequence, the stall branch, production `platform/src/orchestrator/client.ts`, `scripts/verification-*.mjs`. No retry, skip or deadline change.

## Triage

```text
Issue type: test
Fixture level: compact (three test fixtures' diagnostic output; no production code, entrypoint, schema or file-format change; no ordering or deadline change)
Upstream suggested level: absent (issue is needs-triage; only the diagnostic slice is implemented)
Blast radius: the three it.each observer cases and the e2e fixture copy list; a wrong change could add child stderr on success (breaking stderr===''), perturb the stall cancellation, or alter request ordering
Selected risk packs: Error handling / rollback / partial outputs; Concurrency / shared state / ordering
Evidence floor: pnpm test:integration platform/test/deployed-docker-observer.integration.test.ts (three existing cases unchanged + new real-child diagnostic case RED→GREEN), pnpm check:fast
```

`design.md` omitted at compact level. Spec home: `trusted-docker-verification`, next to "Deployed application observation is private and generation-bound", which this fixture verifies.
