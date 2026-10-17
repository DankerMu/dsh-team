# Proposal

## Why

Issue #267 is the user-approved prerequisite for #176. Docker daemon proxy configuration does not configure Buildx's client-side token exchange; verification subprocess allowlists currently discard the standard client proxy inputs.

After the client fix, real provisioning reached apt but timed out at the unchanged600s build deadline: official-source indexes took4m45s and114MB of packages remained. The user explicitly extended #267 to the verification image's Debian source after an authorized existing-proxy exit comparison failed and was rolled back.

## What Changes

- Admit only optional uppercase `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` to verification Docker CLI environments, including the host acquisition producer's Docker grandchildren.
- Preserve private Docker configuration, local Engine selection, each caller's PATH policy and all lifetime/error bounds.
- Keep these inputs out of actual browser processes and employee containers; deliver the shared policy in image and trusted-rescue module bundles.
- Use the Tsinghua mirror for the verification image's ordinary Debian/bookworm and bookworm-updates source only. Retain the official security source, Debian archive keyring/signature checks, suites, package list, base digest and build deadline.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `browser-runtime-verification`: verification Docker client proxy support with environment containment and an explicitly scoped build-time Debian mirror.

## Impact

Verification scripts, Docker command adapters, browser launch/packaging and integration evidence only. No production platform configuration, image pin, dependency, daemon configuration or provider call changes.

## Risk triage

Issue type: bugfix.
Fixture level: expanded.
Upstream suggested level: expanded (agree: shared script/process and secret boundaries).
Blast radius: registry authentication, child environment custody and rescue packaging.
Selected risk packs: CLI/script entry; config; secrets; compatibility; error/cleanup; packaging; documentation.
Evidence floor: process/network RED/GREEN, targeted integration, static checks, exact-head original full Docker and independent host/resource inventories.
