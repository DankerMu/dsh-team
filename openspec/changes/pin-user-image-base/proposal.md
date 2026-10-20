# Proposal

## Why

Issue #273 replaces the production user image's major-only mutable base reference with a reviewed immutable identity. The former reference was the original design choice, not a violation of an existing digest rule or a demonstrated historical failure cause.

## What Changes

- Pin only images/dsh-user/Dockerfile's base to an exact Node24 patch/Bookworm-slim tag plus verified OCI index digest.
- Document explicit reviewed tag/digest updates and fresh trusted qualification; do not imply the dynamic apt/npm dependency closure becomes bit-reproducible.
- Keep all other Dockerfile instructions, other image bases and historical phase0 evidence unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `user-image`: immutable reviewed base identity and update contract.

## Impact

One production image reference and existing deployment/operator guidance; no new dependency, runtime feature, gate relaxation or provider invocation.

## Risk Triage

Issue type: release. Fixture level: expanded (critical production image/supply-chain identity). Upstream level: absent. Selected packs: config, packaging, compatibility, resource limits, error-cleanup, documentation. Evidence floor: authoritative registry digest/platform/config proof, disposable immutable-reference RED/GREEN, actual built image Node/Bookworm/uid/DSH observation and original exact-head full Docker/Compose with independent cleanup. Every changed images/dsh-user line requires human white-box review; user defers that review until remaining work is finished, UNPASSED.
