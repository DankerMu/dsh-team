# Design

**Change surface:**

- `platform/test/gateway-stream-fixture.ts`:
  - `transfer`, the client end;
  - `payloadResources.handler`, the upstream end;
  - `measured`, `stored` and `runLargeTransfer`.
- `platform/test/gateway-stream-trace.ts` (new).
- `platform/test/gateway-stream-attribution.integration.test.ts` (new).

**Must preserve:**

- The three cases in `gateway-stream.integration.test.ts`: same inputs, assertions and budgets (209,715,200 bytes, the fixed SHA-256, `STREAM_RSS_LIMIT`, 30 s transfer, 45 s operation, 60 s test). They are not edited.
- `measured()` keeps its `Gateway stream child failure` evidence and its settlement. The new wrapper sits outside it, with `cause` chained.
- The primary error comes first. A cleanup failure never replaces it.
- `observe` keeps its phases, and an observer failure still aborts the operation.
- `withUpstream` (`gateway-http-fixture.ts`) is not edited. Thirteen other files use it.
- No retry, skip or allowlist.

**Must add:**

- **Per-direction traces, scoped to `/payload` only.** `/warmup` is left out because it may share keep-alive sockets. Each trace has:
  - client `{written, read, status, events[]}`;
  - upstream `{received, sent, events[]}`;
  - the direction's child exit `{exitCode, signal}`, put on the same timeline when the child's `exit` fires.
- **Event shape.** Each event is `{seq, end, stream, kind, ms, code?}`:
  - `end` ∈ client, upstream, child;
  - `stream` ∈ request, response, socket, process;
  - `kind` ∈ finish, end, close, aborted, error, exit.
  - `seq` comes from one counter shared by both ends (they run in the parent process). Ordering uses `seq` only; `ms` is informational.
  - Only the first occurrence of each `(end, stream, kind)` is kept, with at most 32 events per end.
- **Recording never changes error behavior.** Errors are observed with `events.errorMonitor`, never with plain `'error'` listeners. Data is counted by wrapping the existing chunk callbacks: counters only, with no extra buffering or listener-driven flow mode.
- **`firstClose(trace)`** returns:
  - `gateway`, by precedence, whenever the direction's child ended abnormally (a signal or a non-zero code) without `escalated`, whatever its `seq`. A SIGKILL's exit notice and the sockets' close notices reach the parent from separate sources in no fixed order.
  - Otherwise `client` or `upstream`: the end with the earliest close, aborted or error event (by `seq`) not preceded by that stream's own finish or end.
  - `none` otherwise.
- **Kill attribution.** `shutdown()` records whether it escalated to SIGKILL (`escalated: true`), so a probe can tell its own kill from the shutdown escalation.
- **Wrapper.** Its message is `Gateway stream failure <json>`. It is a plain `Error`, never an `AggregateError`, with `cause` set to the original error or aggregate. The JSON holds `phase`, `firstClose`, the traces, and per-direction child `{exitCode, signal, escalated}`. The `:689`/`:690` cleanup path names its phase:
  - after the first failing pipeline's direction (`upstream-pipeline:download`);
  - `payload-cleanup` for an `rm` failure (`:679`) or a cleanup-observer failure (`:685`).

  When a pipeline error and a payload-cleanup error are both present, the pipeline phase is reported.

- **Knob rejection on the timeline.** The CI-signature knob's rejection is recorded as an upstream `error` event with its own `seq`.

**Governing invariant:** every failure of `runLargeTransfer` is a plain `Error` that names its phase and carries the transfer facts known at that moment. The original error stays reachable as `cause`. A passing run only counts and timestamps, and never changes the bytes, the backpressure or the deadlines.

**Sibling surfaces:**

- `measured()`: its wrapper is kept inside the new one.
- `stored()`: currently unwrapped; wrap it.
- Tracked upload and download pipelines and the `errors` array: today an aggregate at `:690`; now the `upstream-pipeline:<direction>` phase.
- `preserve()` aggregates: kept as `cause`.
- `withUpstream` cleanup: wrapped from the caller.
- Client `transfer` rejections: `call` error, `responseWork` and `requestWork`.
- `gateway-stream-process.ts`: none; its stderr diagnostics already go to `measured()`.

**Seams under test:**

- `runLargeTransfer` with the real child, real TCP and real 200 MiB transfers.
- `firstClose`, as a pure function.
- Fault knobs are fixture options. The probes alone use them; the original cases never pass them.

**Required evidence** (each probe parses the JSON after the `Gateway stream failure ` prefix and asserts `!(error instanceof AggregateError)`):

1. **CI signature.** A knob makes the upstream download pipeline reject after the download response's `finish`, with both directions and `stored()` succeeding. Expected:
   - `phase: "upstream-pipeline:download"`;
   - the upstream download `response finish` event's `seq` is lower than the knob's `error` event;
   - upload `client.status === 201`;
   - download `client.status === 200` and `client.read === 209715200`;
   - a plain `Error`.
2. **Child SIGKILLed mid-upload.** The probe keeps the child from the `child` observe event and kills it at the first `upload` event. Expected:
   - `phase: "upload"`;
   - `firstClose: "gateway"`;
   - the upload child `{signal: "SIGKILL", escalated: false}`;
   - `0 < client.written < 209715200`.
3. **Upstream destroys its incoming request after its first chunk** (knob). Expected:
   - `phase: "upload"`;
   - `firstClose: "upstream"`;
   - `0 < upstream.received < 209715200`;
   - `client.written < 209715200`;
   - the upload child `{exitCode, signal, escalated}` is present.
4. **Payload unlinked.** `unlinkSync` runs at the first `child-settled` event, after the upload. Expected:
   - `phase: "stored"`;
   - the cause code is `ENOENT`;
   - no download `child` event was ever observed.

**Red before the change:** each probe fails on the prefix or the trace fields. The existing `measured()` text already contains `"phase":"upload"` and `"signal":"SIGKILL"`, so substring checks would not go red; that is why the probes parse the JSON.

**Unit cases for `firstClose`:**

- a clean trace gives `none`;
- the earliest premature event gives `client` or `upstream`;
- a close after completion is ignored;
- an abnormal, non-escalated child exit gives `gateway` even when both ends' premature events have a lower `seq`;
- an escalated child exit does not give `gateway`;
- equal `ms` values are resolved by `seq`.

**Privacy:** the serialized JSON and the wrapper message contain neither the cookie value nor `dsh-auth`, and no header or body. Only Node error `code` and `name` are recorded. `cause` keeps the original error untouched, so the rule covers the wrapper, not the cause.

**Non-goals:**

- Fixing the premature close. Candidate 1 is a hypothesis; the next recurrence or a later diagnosis decides it.
- Closing #250.
- Editing `withUpstream` or the production gateway.
- Changing any budget.

**Review focus:**

- No data-path cost beyond counters.
- `errorMonitor` only.
- The outermost error is never an aggregate.
- The primary error is never masked.
- Probes are deterministic and own their cleanup.
- The original cases are untouched.
- The fixture stays under 800 lines.
