# Reconcile trusted VPS retirement receipts

## Why

Issue #242 records host cleanup success but a failed local observer and retained admission lock. A controlled run of the unchanged owner now proves one concrete false-negative path: a failed observer Promise is reused after same-invocation finalization has produced a successful canonical receipt. The valid-receipt control already separates execution exit1 from cleanup success. This does not identify the historical observer failure's cause.

## What Changes

- Preserve bounded, sanitized observer process/receipt facts, settling stdout before parsing instead of treating transport failure as an authoritative host result.
- Validate the cleanup receipt and, only when no valid observer receipt exists, read the canonical same-invocation receipt once through the existing bounded recovery path.
- Retain fail-closed invalid/unreachable/cleanup-failed states and exact owner/lock authority; never retry model execution or widen cleanup.
- Add deterministic real-owner process regressions with isolated external-command boundaries, actual local lock predicates and controlled receipt timing; characterize the real worker's read-only receipt path without provider admission.

## Capabilities

### Modified Capabilities

- `managed-config`: trusted model-verification retirement and evidence authority.

## Impact

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded because observation/cleanup authority and asynchronous evidence are security-sensitive.
Blast radius: trusted operator host observation/recovery and exact admission-lock retirement, not tested platform/model behavior.
Selected risk packs: CLI, private file/path custody, auth/secrets, concurrency/state, resource/process limits, compatibility, error/rollback and docs.
Evidence floor: controlled RED/GREEN, receipt/observer timing and failure matrix, execution-versus-cleanup independence, exact/foreign lock effects and no sensitive diagnostics, canonical checks/four-seat review, trusted non-provider smoke and exact-head Docker/Compose/CI.
