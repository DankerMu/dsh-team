# Design

## Context

Production `main.ts` already starts service and application close concurrently. The observed #92 trace completes preClose and service drainage, retires the exact composition helper, and reaches instance state running, but never reaches HTTP server-close/onClose. A subsequent accepted socket has no request event. Installed Fastify5.12.5/Node24.13.1 reproduce this with an independently acknowledged zero-byte TCP connection; generic aborted-request probes without that connection settle normally. Do not infer its production client or a general dependency defect.

## Goals / Non-Goals

**Goals:** retire unclaimed accepted connections at the platform HTTP owner, preserve admitted request/upgrade owners, and unblock the unchanged real Compose failure regression.

**Non-goals:** changing request/response deadlines, force-closing active HTTP, changing gateway/session retirement, cancelling instance startup work, dependency upgrades, Docker cleanup policy, #226 DELETE-tail investigation, DSH or model changes.

## Decisions

- Ownership boundary: TCP acceptance alone is not HTTP admission. A parsed request means complete headers have produced the server request event; its body may remain incomplete. Such admitted work is preserved. Zero-byte connections and incomplete headers remain unclaimed and may be closed on shutdown. This makes the issue's partial-request preservation precise without changing existing body-stream guarantees.
- Attach ownership handling to the application HTTP server. Track only unclaimed sockets, remove them on parsed request/upgrade or close, and fence new accepts when shutdown begins. Observe claim events before application handlers so synchronous shutdown from a handler cannot misclassify its socket.
- Reuse the current application hooks and gateway registry rather than building a second general connection manager. Keep helper logic in the existing application file unless a cohesive lifecycle helper is required for meaningful unit coverage; no business logic or new public route.
- Shutdown destroys only unclaimed sockets. Existing HTTP keep-alive and admitted response settlement remain the HTTP server's responsibility; upgrades stay with gateway ownership. `forceCloseConnections:true`, global `closeAllConnections`, retries, process exit and time-budget changes are rejected alternatives.
- Tests synchronize server acceptance, parsed-request admission and held work explicitly. Deadlines are only failure bounds. Actual TCP integration is the primary oracle; simulated external socket events, if needed for unit coverage, must assert ownership transitions and preserved transports rather than listener wiring.
- Preserve all `buildApp` callers and shared CLI/health/gateway tests. No signature or HTTP contract changes. A combined diagnostic archive may integrate #228 with unmerged #92 solely to replay the original failure; label it explicitly, then require #92's final exact-head gates after merge.

## Risks / Trade-offs

- Claim/shutdown race → claim listeners precede route handling; late accepts see a synchronous closing fence.
- Overbroad retirement → actual incomplete-body/held-response controls and existing gateway upgrade/close regressions must pass unchanged.
- Listener/set retention → remove closed/claimed sockets and dispose hooks only after server settlement.
- Evidence scope confusion → retain raw RED/GREEN, identity and all cleanup outcomes; no diagnostic archive is final-head proof. Production socket client identity remains unknown and is not required to correct the reproduced server-owned cold-socket boundary.

## Migration Plan

No persisted migration. Land the focused fix independently, integrate it into #92, and rerun its unchanged failure path and original full Docker discovery. Revert the lifecycle fix and tests together if rollback is necessary; never replace it with a force-exit fallback. Human rule/critical-path review remains at Epic end under the recorded user decision.
