# Design

## Context

The current application distinguishes accepted sockets without complete headers from claimed HTTP/upgrade transports. Its preClose hook destroys only unclaimed sockets and closes gateway-owned transports; service and database closure remain ordered in onClose. The confirmed failure is a claimed HTTP connection becoming idle after shutdown begins, not an unfinished lifecycle operation.

## Goals / Non-Goals

Goal: complete admitted HTTP responses and retire their keep-alive transport without waiting for client inactivity. Preserve multiple already-parsed requests on one socket and Node stream backpressure.

Non-goals: timeout policy, new request admission semantics, forced transport destruction, changes to gateway ownership, DSH or Docker operations, or an alternate shutdown implementation.

## Decisions

Extend the existing app-level ownership boundary. Register HTTP response ownership before application handlers can synchronously initiate shutdown. Track outstanding responses per actual socket; release each response exactly once on finish or close. During shutdown, end the writable socket only after its last admitted response settles, so bytes already accepted by Node drain before FIN. Keep upgrades outside this accounting and under the existing gateway owner.

Use the existing cold-socket set and normal server close for preexisting idle sockets. Avoid destroying all connections, setting forceCloseConnections, or repeatedly scanning sockets on timers. Response error/cancellation must release ownership without double decrement or retaining dead sockets. Remove application listeners during final close.

Before normal server close, preClose also awaits outstanding response settlement. Node 24's closeIdleConnections checks the response's `finished` flag: end() sets this before buffered writes finish. Real backpressure rejected an end-only repair (1,151,927 of 8,388,608 bytes received). The drain barrier prevents native close from destroying this ended-but-buffered response. Socket close also releases the count when a canceled pipelined response never emits finish. Existing idle connections still use ordinary server close.

The implementation must be adjusted if real pipeline/backpressure evidence disproves the finish/end ordering; do not relax those oracles. A per-socket count avoids allocating a response collection for every socket. No exported API change is intended.

## Risks / Trade-offs

- Ending after the first response can truncate a second admitted request: require a two-response pipeline with the second held across first completion.
- Finish is not remote receipt: require a paused-reader, large-response check of exact bytes before EOF; use orderly end, not destroy.
- Finish and close both occur: cleanup must be idempotent; exercise cancellation with another admitted response.
- Shutdown may begin inside a handler: ownership registration precedes request handling.
- Existing gateway teardown may destroy sockets independently: preserve it, tolerate already-destroyed sockets and retain all existing gateway regressions.
- A client withholding an admitted request body can still retain graceful shutdown. No new timeout policy is authorized.

## Verification and rollback

Retain the original baseline failure log under `.run/issue72/main-keepalive-red.log`. Add the keep-alive variant to the existing close/body/response matrix and run through the root integration command before implementation. Pipeline/backpressure/cancellation cases use real TCP and controlled events, not sleep-based ordering. Verify both source and compiled imports, then `pnpm check`, independent review, exact-head trusted deploy/full Docker and CI. Rollback is a source revert; there is no persistent migration. Resume #72 only after merge; its original connected-client case remains an independent consumer check.

The registration fixture observes shutdown beginning through closure of a separately owned cold connection, not a later preClose hook that now correctly waits for response drainage. Response status/body and the original two-second settlement deadline are unchanged. Disposable first-response-close and early-native-close variants are rejected by the pipeline and byte-integrity oracles respectively; restored source passes all ten cases.

## Workflow deviation

The parent owns the already-mapped coupled fixture/implementation under the higher-priority inline delegation rule; this is not independent fixture admission. Four separate read-only cross-review seats and protected CI/trusted runtime acceptance provide independent checks. No agent runs tests or external provider calls.
