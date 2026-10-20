# Proposal

## Why

The shared platform UI fixture releases its selected public port before database/app construction and later binds the same number, leaving a real ownership gap (#279). Historical main CI reported EADDRINUSE, but its conflicting listener was not captured; the fix must remove the demonstrated gap rather than claim historical attribution or retry until green.

## What Changes

- Retain one invocation-owned public loopback TCP listener continuously from Origin selection through fixture cleanup; forward raw bytes to the real Fastify app's independently bound ephemeral loopback listener only after explicit readiness.
- Reuse the existing canonical byte relay through a dependency-light extraction with one-shot forwarding activation; migrate existing browser runtime consumers and every standalone copy closure atomically.
- Add deterministic competing-bind and cleanup regressions around the shared UI fixture while preserving real compiled assets, HTTP/SQLite, authentication/Origin policy and existing browser failure observers.
- Preserve current full UI discovery and shared browser transport guarantees. No listen retry, fixed shared port, increased deadline, ignored request failure or production network/API change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `browser-runtime-verification`: continuous platform UI public-listener ownership, readiness and exact fixture-resource settlement, while preserving canonical raw browser transport.

## Impact

`account-ui-fixture`, its administrator wrapper/callers and process-boundary regressions; canonical verification byte-relay extraction from `probe-browser-runtime`; browser runtime build/rescue copy manifests and verification-image module delivery. Production `buildApp`, source-address validation, configuration and routing remain unchanged. Shared transport extraction requires fresh original full Docker evidence on this change's final head; unrelated #304 evidence cannot substitute.

## Fixture Contract

Expanded fixture; ownership/lifecycle, async transport, compatibility and evidence packs. Required evidence: deterministic old-boundary RED; competing-bind exclusion during held initialization and use; real same-Origin success and wrong-Origin rejection; normal/setup/callback failure cleanup with an unrelated live listener; current full `pnpm test:ui` with original screenshots and zero-unexpected-error observers; existing relay pressure/half-close/cleanup consumers and exact-head CI/full trusted Docker qualification. Human acceptance remains deferred and unpassed. Implementation is parent-inline under higher-priority single-slice delegation policy; independent four-seat review follows. #304's frozen runtime remains untouched and owns the only active trusted Docker execution.
