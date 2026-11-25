## Risk packs

- **Error handling (selected).** Phase-named errors; the abort cause is kept.
- **Legacy compatibility (selected).**
  - Caller signal composition stays as before.
  - The `HTTP peer observation did not settle` prefix stays.
  - Successful sends are unchanged.
- **Not selected:** schema, auth, security, concurrency, resources, release.

## Acceptance mapping (#719 rows 1–2)

- **Each site has a red probe.** Stall the step and the failure names the phase or the label. On main the failure carries no phase: `Test timed out` or a bare `AbortError` (task 1.2).
- **Five consecutive full `pnpm test:integration` runs at load ≥ 13 and < 67** (task 2.1).

## Must preserve

- **ragflow-proxy.** Its own `RAGFLOW_TIMEOUT_MS` (10 s) path is not cut. Every timeout case calls the client directly with 200 ms, and `withProxy`'s `send` has no hanging handler. State in the report that it is not cut.
- **Stream fixture.** The caller-signal composition (`gateway-stream-fixture.ts:337`) still holds.
- **A caller's abort reason** stays reachable at `error.cause.cause`. This is a regression test, not a red probe: main already exposes it at `.cause`.
- **Non-abort errors** (`ECONNREFUSED`, `ECONNRESET`) are rethrown as the original object with its `code`.
- **Existing assertions.** No existing test asserts a sendHttp or observeHttp error message (grep-verified). The unlabelled message `HTTP peer observation did not settle` is unchanged.
- **`web-startup-fixture.ts:172,193` `observeHttp`** is a local alias of `httpStatus`, not this helper, and is untouched.

## 1. Implementation

Write each probe first and record its red output.

- [ ] 1.1 Measure first.
  - Instrument `sendHttp` temporarily, without committing it. Run the seven gateway caller files and the three ragflow-proxy files five times at load ≥ 67, which is the acceptance band's upper edge (as #687 and slice 1 measured).
  - Record the largest successful send. Done: the max was 400.2 ms at load 67–85. `HTTP_SEND_MS` = 2500 ms (about 6×; 10× = 4002 ms does not fit, see proposal). Write the basis, the factor and the `HTTP_SEND_MS + HTTP_OBSERVATION_MS < 5000` sum into its comment.
- [ ] 1.2 Phase-named `sendHttp` with the named override, the bounded close waits and the labelled `observeHttp`. Pass `HTTP_SEND_SLOW_MS` from `instance-idle.docker.test.ts` and the stream warmup. Probes go in the new sibling test, each red on main because the failure names no phase:
  - A peer that never answers. Main shows `Test timed out in 5000ms` or a bare `AbortError`. After, it shows `sendHttp <METHOD> <path>: response headers …`, well before 5 s.
  - Headers, then silence. After, the phase is `response body`.
  - A labelled observation that never settles. Main has no label in the message; after, the label is present.
  - Regressions:
    - a caller's abort reason at `error.cause.cause`;
    - `ECONNREFUSED` passed through unchanged;
    - an explicit bound overriding the default;
    - the merge helper extracted from `withUpstream` and tested directly with ordinary errors: send error plus close error gives an `AggregateError` with the send error as `cause`; a send error with no close error is rethrown as is; a close error alone is rethrown alone. `withUpstream`'s existing cases stay green. No test-only hook goes into `sendHttp`: a real peer cannot stall the client's close (fixture review: about 3 ms even with a no-op peer `socket.destroy`).
    - a call without `method` or `path` names `GET /`.

## 2. Verification

- [ ] 2.1 Run `pnpm test:integration` 5 times in a row at load ≥ 13 and < 67, then `pnpm typecheck`, `pnpm lint`, `pnpm dead-code` and `pnpm duplicate-code`.
- [ ] 2.2 Exact-head trusted VPS `pnpm test:docker` (instance-idle on the named slow bound) and `pnpm test:deploy`.
