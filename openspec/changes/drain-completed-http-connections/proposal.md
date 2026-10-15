# Proposal

## Why

Issue #246 blocks #72: an admitted request can finish its complete response after shutdown begins, yet its newly idle keep-alive connection retains `app.close()`. The unchanged main registration case reproduced this with a complete 201 response followed by the existing two-second shutdown observation failure.

## What Changes

- Retire completed HTTP keep-alive connections during graceful shutdown, after all already-admitted responses on that connection settle.
- Preserve admitted bodies, pipelined requests, buffered response bytes, gateway ownership and lifecycle/database drain ordering.
- Extend real TCP shutdown regressions; no timeout increase or client-side connection-close workaround.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `http-shutdown`: completed keep-alive transports cannot retain shutdown; admitted pipelined and backpressured responses remain complete.

## Impact

Scoped to platform HTTP connection ownership in `platform/src/app.ts`, shutdown integration tests and existing operating documentation. No HTTP API/schema, dependency, Docker lifecycle or DSH changes. #72 remains separately stashed until this prerequisite merges.

## Fixture and assurance

Expanded fixture; Construction/Critical because connection ownership crosses asynchronous shutdown and can truncate committed HTTP responses. Risk packs: concurrency (pipeline/finish races), lifecycle (finish/error/cancellation), compatibility (existing cold sockets and gateway shutdown), evidence (real TCP bytes and exact-head deployment).

Must preserve all existing shutdown tests, current authorization, service/activity/SQLite ordering, and already-admitted work. Non-goals: shutdown deadlines, retries, blanket force-close, external model calls, new admission policy or production telemetry.

Required evidence: semantic RED on the unchanged implementation; source and compiled actual HTTP runs; pipeline, backpressure and disconnect regressions; `pnpm check`; four independent read-only review perspectives; exact reviewed-head `pnpm test:deploy` and original full `pnpm test:docker` on giap-vps; protected CI and owner Docker attestation. Human critical-path review remains deferred to Epic completion under the existing authorization.
