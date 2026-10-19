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
3. Same-owner explicit start/stop and fresh-owner awaited reconciliation use one recovery implementation inside the original FIFO. Capture current account/row and compare the durable account incarnation/prior-row fingerprint; recheck after each read and immediately before mutations/commit. A different current row is a quarantine, not a reason to erase the receipt.
4. A candidate must match nonce, user, canonical name, immutable image, any learned ID, captured network declaration/topology, expected home/work volumes and read-only overlay. It must be positively never-started, with no extra networks/publication. Inspect by name then exact ID; persist the verified ID before deleting it. Only non-force exact-ID DELETE is allowed. Never rename an unknown container to free its name.
5. After exact container absence and canonical-name absence, reuse captured-network retirement, preserving unrelated/platform/sibling endpoints. Clear the receipt and record a terminal safe error atomically with the existing startup-failure audit. Partial deletion/network/DB failures retain the receipt so another owner can finish. No fictitious stopped audit for a never-started container.
6. An unknown-ID attempt with no observed candidate remains explicit quarantine: a404 cannot prove an interrupted server-side submission will not materialize later. A known-ID attempt may finish only after both exact-ID/name absence and captured-network checks. No timer turns ambiguity into absence. Old resources without a durable attempt retain existing non-adoption behavior.
7. Durable pending attempts exclude stale routing and produce the existing safe error machine state, not stopped success; in-flight ownership retains starting semantics. Stop may acknowledge only verified recovery, and disable/enable retains current authority. Reconciliation automatically recovers matching attempts before ordinary indexed/network reconciliation; unresolved attempts remain explicit failures. Recovery alone never starts an employee instance; explicit retry remains required.

## Verification and sequencing

First migrate/reopen and establish write-before-create/atomic-consumption evidence; then implement one identity-bound recovery path and its unit boundaries. Wire start/stop/reconcile/status without duplicating authority. Exercise lost wire response, inspection failure, deadline and service cancellation; reopen the same file database under a new owner and recover the actual retained identity. Real Docker injects after Engine application and observes through an independent client, with volume sentinels and sibling snapshots. Run source/dist smoke, original full gates and four-seat review.

## Risks / Trade-offs

- Durable provenance increases schema/lifecycle surface → additive migration, one canonical recovery module, bounded fields and transaction rollback tests; justify diff-limit exemption if needed, never shrink acceptance to fit.
- A late create can outlive a failed client → retain unknown absence rather than falsely confirming cleanup; recover when the bound resource is observable.
- Malformed/stale/foreign/running resources → no deletion or receipt erasure; fixed safe failure, no inspect/env diagnostics.
- Existing installations may already have unindexed containers without provenance → no retrospective authority; explicit operator investigation remains necessary for those historical resources.

## Migration and containment

Apply migration3 through the existing ledger; prove versions1/2 historical rows/settings/audits unchanged and source/dist reopen. Deploy only after prior owner drainage. Rollback must not run an older lifecycle owner while unresolved attempts exist; retain database/receipts and use the reviewed version to settle them first. No destructive downgrade migration or compatibility shim.
