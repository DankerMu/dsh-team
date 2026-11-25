# Bound sendHttp below the default case budget and name its stalled phase; label observeHttp stalls

## Why

#719 slice 2 covers rows 1 and 2. Slice 1, PR #727, handled rows 3–6. Line numbers are against main `1e63467`.

1. **`sendHttp` cannot fail before vitest does.**
   - `sendHttp` (`platform/test/gateway-http-fixture.ts:157-206`) has a fixed 5 s abort, `AbortSignal.timeout(5_000)`, at `:174-177`.
   - The integration project has no `testTimeout`, so the 54 calls in its seven gateway caller files, plus about 26 through `ragflow-proxy-fixture.ts:79` `send` (datasets, documents, retrieval) run under vitest's default 5 s case budget:

     | caller file                | calls |
     | -------------------------- | ----- |
     | gateway-activity-lifecycle | 7     |
     | gateway-connections        | 3     |
     | gateway-http-lifecycle     | 2     |
     | gateway-http               | 17    |
     | gateway-routing            | 6     |
     | gateway-session-cache      | 9     |
     | session-heal               | 10    |

   - The inner bound is not shorter than the case budget, so a stalled peer always surfaces as an unattributed `Test timed out in 5000ms`.
   - Even when the abort fires, its error is a bare `AbortError` that names neither the request nor the phase.
   - The `finally` waits on request and response `close` with no bound.
2. **`observeHttp`'s bound is fixed and its error names no stall.**
   - `observeHttp` (`:213-226`) uses the fixed 2 s `HTTP_OBSERVATION_MS`. Its measured basis (#687) is a worst case of 87 ms at load 68–84, so it sits below the default case budget.
   - Its error, `HTTP peer observation did not settle`, does not say which observation stalled.
   - No failure has been observed; this is latent.

## What Changes

- **`sendHttp`.**
  - **Default bound.** Each send is bounded by a named default, `HTTP_SEND_MS`, instead of the literal 5 s.
    - The value comes from a load measurement: about 10× above the largest successful send, and at most 2500 ms.
    - The sum `HTTP_SEND_MS + HTTP_OBSERVATION_MS` (the close wait) therefore stays below the default 5 s case budget, leaving room for the case's setup.
  - **Named override.** `sendHttp` takes an optional named bound for callers whose sends are legitimately slower and whose case budgets are far larger. The default is `HTTP_SEND_MS`.
    - `instance-idle.docker.test.ts` (real DSH and cold container starts, case budget 900 s) passes `HTTP_SEND_SLOW_MS = 5000`.
    - The `gateway-stream-fixture.ts:337` warmup (the first request to a new child, parallel to a 400 MiB transfer, case budget 60 s) passes the same constant.
    - The constant's comment states that it keeps today's 5 s under those budgets.
  - **Phase-named failure.** When the bound or the caller's signal aborts a send, it fails with `sendHttp <METHOD> <path>: <phase> …`. The method and path are the ones Node uses, so a call with neither prints `GET` and `/`, not `undefined`.
    - The phase is `response headers` (no response yet) or `response body` (headers seen, no end).
    - The error's `cause` is the original Node `AbortError`. Its own `.cause` still carries a caller's abort reason, which pins the caller reason at `error.cause.cause`.
    - Non-abort errors such as `ECONNREFUSED` and `ECONNRESET` are rethrown unchanged, as the original object with its `code`.
  - **Bounded close.** The `close` waits in `finally` (request and response close) are bounded through a labelled `observeHttp`.
    - If the send failed and the close then stalls, the failure is an `AggregateError` of the send error and the close error, with `cause` set to the send error. This merge is the one already inline in `withUpstream` `:95-126`. It moves into one small helper in `gateway-http-fixture.ts`, and both `withUpstream` and `sendHttp` call it (one implementation).
    - If the send succeeded and the close stalls, the close error alone names the `close` phase.
    - This is defensive and review-only: a peer cannot delay the client's close after `destroy()`. The fixture review measured it at about 3 ms, even with a no-op peer `socket.destroy`.
- **`observeHttp`.**
  - Takes an optional label. A stall fails with `HTTP peer observation did not settle: <label>`; with no label the message is unchanged.
  - The fixture's own internal observations pass labels: upstream server close, upstream sockets close, and the others at `:260` and `:286`.
  - `HTTP_OBSERVATION_MS` stays 2000 ms, which its #687 measurement supports. Its comment gains its relation to the default 5 s budget. Row 2 is recorded as a fixed bound below that budget, not a derived one.
  - Row 2's site is the helper itself, so one labelled probe covers it. Callers in the 25 files may pass labels but are not required to.

## Triage

```text
Issue type: test-infrastructure bugfix
Fixture level: compact (one shared test fixture; behaviour of successful sends unchanged)
Upstream suggested level: absent
Blast radius: platform/test/gateway-http-fixture.ts and its integration test; every sendHttp/observeHttp caller sees only a shorter failure bound and a richer message
Selected risk packs: Error handling (phase-named failures, cause kept); Legacy compatibility (caller signal composition, existing message prefix)
Evidence floor: red probes on main = no phase in the failure (main shows `Test timed out` or a bare AbortError), green with the named phase before 5 s; labelled-observation probe red = no label; HTTP_SEND_MS measurement at load ≥67 over the seven gateway files and the three ragflow-proxy files; five consecutive full pnpm test:integration at load ≥13 and <67; exact-head VPS pnpm test:docker (instance-idle on the named slow bound) + pnpm test:deploy
```

## Capabilities

### Modified Capabilities

- `integration-test-budgets`: the shared HTTP helpers fail a stalled send or observation before the default case budget, naming the request and the phase.

## Impact

- `platform/test/gateway-http-fixture.ts` and a new sibling `platform/test/gateway-http-fixture.integration.test.ts`.
- `platform/test/instance-idle.docker.test.ts` and `platform/test/gateway-stream-fixture.ts`, which pass the named slow bound.
- No production code.
