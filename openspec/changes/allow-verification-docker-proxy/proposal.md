# Proposal

## Why

Issue #267 is the user-approved prerequisite for #176. Docker daemon proxy configuration does not configure Buildx's client-side token exchange; verification subprocess allowlists currently discard the standard client proxy inputs.

## What Changes

- Admit only optional uppercase `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` to verification Docker CLI environments, including the host acquisition producer's Docker grandchildren.
- Preserve private Docker configuration, local Engine selection, each caller's PATH policy and all lifetime/error bounds.
- Keep these inputs out of actual browser processes and employee containers; deliver the shared policy in image and trusted-rescue module bundles.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `browser-runtime-verification`: verification Docker client proxy support with environment containment.

## Impact

Verification scripts, Docker command adapters, browser launch/packaging and integration evidence only. No production platform configuration, image pin, dependency, daemon configuration or provider call changes.

## Risk triage

Issue type: bugfix.
Fixture level: expanded.
Upstream suggested level: expanded (agree: shared script/process and secret boundaries).
Blast radius: registry authentication, child environment custody and rescue packaging.
Selected risk packs: CLI/script entry; config; secrets; compatibility; error/cleanup; packaging; documentation.
Evidence floor: process/network RED/GREEN, targeted integration, static checks, exact-head original full Docker and independent host/resource inventories.
