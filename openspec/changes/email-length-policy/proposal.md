# Proposal

## Why

Issue #126 identifies unbounded email fields in accounts and login-failure audit records despite the request-body ceiling. The user explicitly chose “254个Unicode码点” and “明确拦截升级，先处理账号”; historical audit evidence must remain intact.

## What Changes

- **BREAKING**: registration, login and administrator CLI reject emails exceeding 254 Unicode code points after trimming and lowercasing, before persistence.
- Bound newly supplied actor/target audit email metadata without truncation or rewriting it.
- **BREAKING**: platform startup refuses existing over-limit account identities before Docker reconciliation or listening; no automatic account modification.
- Preserve historical audit rows and event/time browsing; over-limit HTTP email filters remain rejected rather than matching a truncated identity.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `account-auth`: canonical email bounds and explicit existing-account upgrade refusal.
- `audit-log`: bounded new email metadata and unchanged historical evidence.

## Impact

Auth normalization, shared Unicode counting, database compatibility checks, audit persistence and source/built startup; no database migration or dependency changes.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; auth, persistence and upgrade compatibility require expanded.
Blast radius: registration/login/CLI admission, audit transaction rollback and startup availability.
Selected risk packs: Public API / CLI / script entry; Schema / columns / units / field names; Auth / permissions / secrets; Resource limits / large input / discovery; Legacy compatibility / examples; Error handling / rollback / partial outputs; Release / packaging / dependency compatibility; Documentation / migration notes.
Evidence floor: semantic RED/GREEN at HTTP/storage boundaries, Unicode/password regression, source/dist refusal and unchanged file-database evidence, focused CLI/integration, required CI and trusted exact-head Docker evidence.
