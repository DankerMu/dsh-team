# Proposal

## Why

Issue #166 identifies a runtime/schema mismatch: PUT model entries silently discard unknown fields although the published schema forbids them. Enforce that existing contract instead of legitimizing silent typo acceptance.

## What Changes

- PUT rejects any model-entry key other than `name` and `contextWindow` with safe400 and no settings/audit mutation.
- Keep canonical model value validation and stored-model projection semantics unchanged; no historical-data migration.
- Document the HTTP policy and prove request/response contract alignment without hand-editing OpenAPI.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `admin-console`: explicit model-entry write allowlist and historical read compatibility.

## Impact

One HTTP descriptor, its existing tests and API documentation; no shared parser, authorization, credential custody or lifecycle change.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; public persisted-configuration boundary requires expanded despite the small implementation.
Selected risk packs: Public API; Schema/fields; Auth/secrets; Legacy compatibility; Error handling/rollback; Documentation.
Evidence floor: real HTTP typo400 with unchanged exact settings/audit rows, valid contextWindow preservation, stored-extra-field GET projection without rewrite, existing security regression, source/dist file-database smoke, required CI and exact-head trusted release evidence.
Decision source: existing `additionalProperties:false` publication and fail-loud configuration policy; no new user preference is asserted.
