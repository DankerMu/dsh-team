# Proposal

## Why

Issue #270 identifies the platform-image Docker test as a caller that still inherits the entire shell environment and ambient Docker configuration. It must use the established verification client custody boundary without changing the image or its artifact assertions.

## What Changes

- Replace the test-local Docker adapter with the canonical helper and require the launcher's private configuration.
- Preserve arguments, timeout milliseconds,16MiB output bound, raw results and exact-owned cleanup. The user explicitly approved adopting the helper's SIGKILL timeout termination instead of the old implicit SIGTERM.
- Reuse existing real-child proxy/custody regressions; qualify this caller with a disposable real-child RED/GREEN and trusted real-image canaries.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `browser-runtime-verification`: explicitly cover platform-image verification under the existing client custody contract.

## Impact

`platform/test/platform-image.docker.test.ts` and existing operator guidance; no dependencies, public API, image, production runtime, model calls or host configuration changes.

## Risk Triage

Issue type: bugfix. Fixture level: expanded (secret custody and Docker cleanup consumer). Upstream level: absent. Blast radius: platform-image verification client only. Selected packs: script-entry, config, secrets, resource-limits, compatibility, error-cleanup, packaging, documentation. Evidence floor: actual child RED/GREEN, existing proxy/command regressions, trusted canary platform-image run, original full Docker/Compose, independent cleanup and unchanged host fence. Implementation/fixture admission remain parent-inline because this is one coupled slice; four independent high-risk review lenses follow.
