# Proposal

## Why

#192 is reproduced over the real Unix Docker client and file SQLite: a created but never-started container remains without an instance row after a lost response or failed inspection; retry fails at the name fence and no-row retirement falsely confirms cleanup. The user explicitly requires recovery after platform restart, not only owner-lifetime quarantine.

## What Changes

- Persist nonsecret, per-attempt provenance before submitting final container creation; clear it atomically with successful instance creation persistence.
- Recover only the exact never-started attempt through the existing per-user queue, including a fresh owner after restart. Preserve both data volumes and unrelated resources.
- Keep uncertain, foreign, running or changed-identity resources quarantined; status/retirement must not report a clean stopped state. No name-only adoption or deletion.
- Migrate the private SQLite database additively and update the migration ledger consumers and deployment recovery guidance.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `instance-lifecycle`: durable ambiguous-create recovery, safe quarantine and cross-restart behavior.

## Impact

Orchestrator creation/retirement/reconciliation and service observations; SQLite migration and its source/dist verification; lifecycle integration and real Docker acceptance. No endpoint shape, dependency, provider, DSH-source or host-maintenance change.

## Risk triage

Issue type: bugfix. Fixture level: expanded. Upstream suggested level: absent; destructive lifecycle recovery, durable state and ordering require expanded review.
Blast radius: wrong deletion authority, false account-disable completion, lost volume data, stale routing or migration failure.
Selected risk packs: public API; file IO; schema; auth/secrets; concurrency; discovery; legacy compatibility; error/rollback; release; documentation. Config/setup is not selected: no new environment input.
Evidence floor: observed wire RED; migration/reopen, semantic cancellation/deadline/transport and identity regressions; source/dist smoke; real Docker fault injection on giap-vps; original full Docker/Compose, canonical checks, four-seat review and protected CI. Critical-path human review retains the user's existing Epic-end deferral and is not claimed passed.
