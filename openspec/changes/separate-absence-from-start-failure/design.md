# Design

## Context

See proposal.md. Current `failures` entries carry both exceptional-work identity and a pending verified-absence marker; unconditional finalization conflates completed capacity refusal with failure. The owner already proves exact container404 against unchanged account/row and separately rereads canonical capacity excluding the requesting user. Existing gateway outcome mapping already supplies503/302 for ordinary unavailable states.

## Goals / Non-Goals

Governing invariant: a matching verified-absent identity cannot regain routing merely because its flight settles or a retry begins; ordinary denied admission is not an exception.
Must preserve: same-user flight coalescing, row/account fences, readiness ownership, generic-inspect healthy reuse, actual failure500/502, durable error states, shutdown drainage, sibling rows/endpoints and existing capacity policy.
Non-goals: durable state migration, new lifecycle states or cached last outcomes, additional capacity counters, automatic retries, eviction, auth/schema changes, repairing arbitrary Docker errors or changing provider behavior.

## Decisions

1. Keep separate owner-lifetime identity receipts for verified absence and exceptional work. Reuse the existing identity comparison; remove the conflated pending flag rather than introducing another lifecycle-state cache. A verified-absence callback changes only the receipt matching its exact current row.
2. Observation checks genuine exceptional receipts first. A matching absence bypasses the stale running/starting row projection; an active owned flight remains starting. Without a flight, reuse current model completeness and `owner.hasCapacity(userId)` for unconfigured/full/stopped. Do not cache the POST result.
3. Explicit admission may clear an ordinary prior exceptional receipt, but never removes a matching absence fence by itself. An actual failed replacement still records an exceptional receipt for that fenced identity, including catch-time storage failure. A changed trusted current identity supersedes old receipts; verified successful ownership must precede any routing, never the act of retrying.
4. Keep existing HTTP/WS mappings and public response shapes. Move the existing HTTP fixture into the shared instance fixture only if needed by the added integration scenario; do not create a duplicate app/service setup.
5. Prove A/B running, capacity2→1, exact A404 and full refusal through real InstanceService/authenticated API with a controlled external Unix Engine. Independently count old HTTP/WS upstream hits, preserve B's exact row/routing, change live capacity/model settings, and require new-identity readiness after release. Existing failed-image/changed-ready-identity controls remain required.
6. Add a real Docker scenario using existing owned user-image/public-instance helpers: ready A/B, reduce capacity, remove only the captured ownership-verified A test container, observe ordinary full, release B and retry to a different ready identity. No provider call. This is runtime proof beyond the controlled Engine regression.

## Risks / Trade-offs

- Accidentally reviving the old endpoint while clearing an error → independent old-upstream hit counters and generic-inspect/failed-image controls.
- Masking real failures as ordinary capacity → retain matching exceptional receipts and explicit500/502 checks.
- Stale model/capacity projection or sibling damage → mutate current settings and compare B's identity, row and routes before/after.
- Critical orchestrator path → independent high-risk frozen-head review before trusted Docker execution. Human line review remains deferred to Epic completion under the user's authorization; retain the exact PR/SHA/path ledger and never report it as passed.

## Migration Plan

No persisted format or input migration. Replace the service bookkeeping in place and migrate all affected tests/helpers atomically. Rollback is a reviewed revert; no compatibility alias or shared fallback. Existing startup reconciliation remains responsible for fresh-process state.
