# Design

## Context

See proposal.md. Existing per-user FIFO, bounded submitted-network settlement, exact-ID retirement, private SQLite migrations and exceptional service receipts remain canonical. User selection requires durable recovery across process restart; owner-local receipts alone are insufficient. The two observed RED cases cover lost create response and failed post-create inspection, not real Engine proof.

## Goals / Non-Goals

- Goal: recover a previously submitted, durably bound, never-started attempt without inventing an instance or deleting user data.
- Preserve: current account and complete row fences, disabled-account retirement, admission rules, original FIFO/queue drainage, captured transport, healthy siblings, auth/session and audit transactions.
- Non-goals: adoption/start of the abandoned container, arbitrary discovery cleanup, running-container recovery, global prune, volume deletion, new endpoints, provider calls, retries/deadline growth, or concurrent independent platform owners.

## Decisions

1. Add `creation_attempts`, one row per user, before final create. Store a random attempt nonce, account incarnation, expected image, exact captured network ID/subnet, overlay path, transport mode, prior-instance fingerprint and optional learned container ID. Never serialize credentials, environment, passwords or full inspect documents. Existing rows and migrations remain immutable.
2. Put the nonce on the create request. Persist a valid returned ID before post-create inspection. Successful instance row plus creation audit consumes the attempt in the same transaction, before container start. A failure cannot discard this provenance. Retain original bounded cancellation/settlement semantics; no hidden producer is detached from the queue.
3. Same-owner explicit start/stop and fresh-owner awaited reconciliation use one recovery implementation inside the original FIFO. Capture current account/row and compare the durable account incarnation/prior-row fingerprint; recheck after each read and immediately before mutations/commit. A different current row is a quarantine, not a reason to erase the receipt. The canonical activity writer defers while a receipt exists, retaining its coalesced dirty observation; resolution permits normal throttled writeback without refreshing or weakening the fingerprint.
4. A candidate must match nonce, user, canonical name, immutable image, any learned ID, captured network declaration/topology, expected home/work volumes and read-only overlay. It must be positively never-started, with no extra networks/publication. Inspect by name then exact ID; persist the verified ID before deleting it. Only non-force exact-ID DELETE is allowed. Never rename an unknown container to free its name.
5. After exact container absence and canonical-name absence, reuse captured-network retirement, preserving unrelated/platform/sibling endpoints. Clear the receipt and record a terminal safe error atomically with the existing startup-failure audit. Partial deletion/network/DB failures retain the receipt so another owner can finish. No fictitious stopped audit for a never-started container.
6. An unknown-ID attempt with no observed candidate remains explicit quarantine: a404 cannot prove an interrupted server-side submission will not materialize later. A known-ID attempt may finish only after both exact-ID/name absence and captured-network checks. No timer turns ambiguity into absence. Old resources without a durable attempt retain existing non-adoption behavior.
7. Durable pending attempts exclude stale routing and produce the existing safe error machine state, not stopped success; in-flight ownership retains starting semantics. Stop may acknowledge only verified recovery, and disable/enable retains current authority. Reconciliation automatically recovers matching attempts before ordinary indexed/network reconciliation. Both phases recheck current attempts inside their per-user FIFO, including attempts introduced after the initial user inventory. Recovery alone never starts an employee instance; explicit retry remains required.
8. User-authorized round1 clarification: only a valid unchanged receipt with no learned ID, definite canonical404 and verified captured-network state becomes an explicitly classified nonfatal quarantine during reconciliation. Its receipt/bridge remain, status is error and explicit start/stop still fail; awaited startup may then serve verified healthy siblings. Identity/topology conflicts, malformed receipts, storage failures and Docker query/discovery errors remain fatal. Do not implement generic catch-and-continue or allow orphan-network cleanup of the quarantined bridge.

## Verification and sequencing

First migrate/reopen and establish write-before-create/atomic-consumption evidence; then implement one identity-bound recovery path and its unit boundaries. Wire start/stop/reconcile/status without duplicating authority. Exercise lost wire response, inspection failure, deadline and service cancellation; reopen the same file database under a new owner and recover the actual retained identity. Real Docker injects after Engine application and observes through an independent client, with volume sentinels and sibling snapshots. Run source/dist smoke, original full gates and four-seat review.

## Risks / Trade-offs

- Durable provenance increases schema/lifecycle surface → additive migration, one canonical recovery module, bounded fields and transaction rollback tests; justify diff-limit exemption if needed, never shrink acceptance to fit.
- A late create can outlive a failed client → retain unknown absence rather than falsely confirming cleanup; recover when the bound resource is observable.
- Malformed/stale/foreign/running resources → no deletion or receipt erasure; fixed safe failure, no inspect/env diagnostics.
- Existing installations may already have unindexed containers without provenance → no retrospective authority; explicit operator investigation remains necessary for those historical resources.

## Migration and containment

Apply migration3 through the existing ledger; prove versions1/2 historical rows/settings/audits unchanged and source/dist reopen. Deploy only after prior owner drainage. Rollback must not run an older lifecycle owner while unresolved attempts exist; retain database/receipts and use the reviewed version to settle them first. No destructive downgrade migration or compatibility shim.

## Authorized build-diagnostic prerequisite

The real Compose run at `83ee34e3ae71fdc7da2c30607dc3a1910d351888` failed at platform image build with null status and only the generic redacted failure. Its607757ms case duration against a600000ms command deadline does not establish a root cause. The user authorized bounded diagnostics and one additional fix/review pass, not an unchanged blind rerun.

- Extend the existing Docker command redaction owner for build failures only. Preserve child closure, byte limits, no-input behavior, credential filtering, exact absence recognition and every original deadline.
- Emit fixed-schema scalar facts: measured elapsed time, configured deadline, numeric exit status, allowlisted signal, and termination classification derived from actual process observations (`deadline`, `output-limit`, `spawn-failure`, `signal`, `exit`, `unknown`). Never infer deadline from elapsed time or null status.
- Build progress is an optional last-observed structural stderr marker, not a stalled vertex or cause: retain only bounded numeric vertex/step identities and fixed phase/instruction/status enums. BuildKit concurrency and unrecognized/truncated output remain explicit limits. Never retain descriptions, RUN bodies, paths, URLs, arguments, environment or raw error/output excerpts. No BuildKit history access.
- The final emitted failure must carry those safe facts; the diagnostic is not resource cleanup authority. Both synchronous and asynchronous build paths retain the same redaction. Other command failures keep their existing contract.
- Qualify using secret-bearing synthetic results and actual child-process timeout, output-limit, spawn/signal/nonzero-exit and successful closure. Preserve existing lifecycle/cleanup tests. Run a throwaway final-output smoke, canonical checks, full-diff review and fresh exact-head Compose/full Docker. No retrospective cause claim even if the new run passes.
