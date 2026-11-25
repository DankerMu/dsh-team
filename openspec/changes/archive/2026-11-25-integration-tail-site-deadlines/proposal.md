# Bound the remaining tail sites of #719

## Why

Issue #719, **slice 1 of 2**. It covers table rows #3–#6. Slice 2 covers `sendHttp` and `observeHttp` (rows #1–#2) under its own change. Line numbers refer to main `a4efa57`. Under load each of these sites either has no bound or applies a bound computed from the wrong start time, so a failure shows up as an unattributable `Test timed out` or as a spurious red. The fix follows #687: declare a budget, derive each inner wait from what remains of it, and name the phase in the failure message.

- **#3 `ragflow-proxy-auth.integration.test.ts:333-347`, "application close aborts an in-flight version read":**
  - `upstream.received(1)`, `pending` and `upstream.socketClosed(1)` (`model-upstream-fixture.ts`) are unbounded promises.
  - `expect(performance.now() - started).toBeLessThan(5_000)` is a wall-clock assertion with no named basis.
  - A stall shows up only as the file's 22 s `Test timed out`.
- **#4 `instance-lifecycle.integration.test.ts:509-517`, in the canonical dev-stop case:** `registerInstanceUser(...)`, the `POST /_platform/api/instance/start` `fetch` and its `arrayBuffer()` are unbounded. The case's own ledger comment (`:481-484`) admits this. A stall becomes an unattributed timeout after 160 s.
- **#5 `chrome-start.integration.test.ts:218-229`, "a near case deadline cuts it":** `receiptWriteFault.deadline = Date.now() + offset` is set before `fakeChrome`, registration and spawn. When that prework takes longer than 1.5 s under load, the deadline has already passed when the acknowledgement wait starts, and the row fails red even though nothing is wrong.
- **#6 `document-server-net-script.integration.test.ts:31` (`EXIT_MS` 3 s):** it failed once at a 1-minute load of about 80, which is above the acceptance band (< 67) of both #687 and #719. The issue asks only that this be recorded.

## What Changes

`boundedStep` (`auth-tcp-fixture.ts:121-133`) only hands its step an `AbortSignal`, so a step that ignores the signal is never cut off. Every wrapped step below either accepts the signal or is made to reject when it aborts.

- **#3, ragflow close-abort.**
  - **`pending`.** It is created as `boundedStep('close-abort: pending answer', deadline, (signal) => send(VERSION, { headers, signal }))`, so its bound starts when the request is sent. If an earlier phase fails, its rejection is observed (for example with `.catch` kept for a later `await`), so it never surfaces as an unhandled rejection.
  - **`upstream.received(1)` and `upstream.socketClosed(1)`.** These are made to reject on abort, either through an existing signal-race helper if one exists, or through an optional `signal` parameter on those two `model-upstream-fixture.ts` methods. They are then bounded as `close-abort: upstream received` and `close-abort: upstream socket closed`.
  - **`app.close()`.** It is bounded as `close-abort: application close`.
  - **The `< 5_000` assertion.** It becomes a named constant with a measured basis.
- **#4, lifecycle register and start.**
  - **Registration.** It is wrapped once from outside, as `boundedStep('user registration', d, (signal) => registerInstanceUser(base, base, email, (u, i) => fetch(u, { ...i, signal })))`. That single step covers the helper's own body reads.
  - **Start.** One `instance start` step covers the `fetch` and `arrayBuffer()`. `expect(response.status)` stays outside the wrap.
  - **Bounds.** Each step's bound is a named constant measured under load. Both enter the ledger with the cleanup reserve kept, and `OWNERSHIP_CASE_MS` (160 s) stays unchanged. If the measured maxima do not fit, the implementer stops and reports instead of raising the budget.
- **#5, chrome-start.** The near deadline is measured from where the acknowledgement wait starts.
  - `receiptWriteFault` stores the offset, and `failAcknowledgedReceipt` computes the deadline from its own `since`.
  - Registration, port allocation, spawn and `processBirth` inside `startChrome` can therefore no longer use up the offset.
  - The 0-offset row keeps its "case deadline passed before it started" attribution, and the regexes are unchanged.
- **#6.** No code change. This proposal and the PR record that the failure is outside the acceptance band.

`design.md` is omitted: compact, test-only.

## Triage

```text
Issue type: test (load reliability)
Fixture level: compact
Upstream suggested level: absent
Blast radius: three integration cases' failure attribution under load; a bound shorter than the measured step would add false reds
Selected risk packs: Concurrency / ordering (deadline start point, load); Error handling (phase-named failure)
Evidence floor: red probes per site (stall -> phase-named failure below the budget); measured maxima under load; 5 loaded full pnpm test:integration runs started at 1-minute load >= 13 and < 67; pnpm lint/typecheck; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `integration-test-budgets`: the remaining tail sites declare measured bounds and name their stalls.

## Impact

- `platform/test/ragflow-proxy-auth.integration.test.ts`, `platform/test/instance-lifecycle.integration.test.ts`, `platform/test/chrome-start.integration.test.ts`
- `platform/test/model-upstream-fixture.ts` (optional `signal` on `received`/`socketClosed`), unless an existing helper covers the race
- The PR uses `Refs #719`, not `Closes`: slice 2 still has to land.
