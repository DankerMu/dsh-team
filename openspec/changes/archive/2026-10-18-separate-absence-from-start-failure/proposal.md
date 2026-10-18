# Proposal

## Why

Issue177 identifies a normal replacement-capacity refusal that becomes an exceptional status after startup work settles. The service currently uses the same receipt for an exact-ID verified absence and an actual operation failure; its finalizer turns a completed `full` result into subsequent GET500/gateway502 while correctly preventing stale routing.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded for shared state, authenticated API and credential-routing boundaries.
Blast radius: instance status, HTTP/WebSocket gateway availability and stale endpoint/credential isolation.
Selected risk packs: public API, configuration precedence, authorization/secrets, concurrency/shared state, capacity, error handling and documentation.
Evidence floor: semantic public-boundary RED/GREEN, existing failure controls, real targeted Docker scenario, original full Docker and protected CI.

## What Changes

- Separate identity-fenced verified absence from exceptional operation failure; neither stores endpoints, credentials or cached capacity outcomes.
- After ordinary denied replacement, project current model completeness and canonical other-user capacity while continuing to reject the absent old identity for routing.
- Preserve actual operation failures, successful verified replacement, sibling routing, current authorization and existing startup/shutdown ownership.
- Add authenticated HTTP/WebSocket and real Docker evidence; update existing lifecycle guidance. No route/schema or capacity-policy change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `instance-lifecycle`: ordinary admission refusal after verified absence remains a current safe machine state, distinct from actual operation failures.

## Impact

Primary implementation owner: `platform/src/orchestrator/instance-service.ts`. Existing owner absence/capacity APIs and gateway mappings should remain unchanged unless executable evidence identifies a necessary contract adjustment. Tests reuse existing service/Unix-Engine/HTTP and user-image lifecycles. No dependency, environment input, database migration, eviction policy, retry loop or DSH-source modification.
