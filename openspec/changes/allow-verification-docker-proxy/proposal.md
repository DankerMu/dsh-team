# Proposal

## Why

Issue #267 is the user-approved prerequisite for #176. Docker daemon proxy configuration does not configure Buildx's client-side token exchange; verification subprocess allowlists currently discard the standard client proxy inputs.

After the client fix, real provisioning reached apt but timed out at the unchanged600s build deadline: official-source indexes took4m45s and114MB of packages remained. The user explicitly extended #267 to the verification image's Debian source after an authorized existing-proxy exit comparison failed and was rolled back.

The verification image then built and qualified actual Chrome, while the unchanged user image independently hit the same600s apt deadline. The user explicitly extended the same ordinary-source policy to the user-image build, requiring shared implementation and preserving its security source, trust, base reference, DSH version, packages and runtime behavior.

## What Changes

- Admit only optional uppercase `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` to verification Docker CLI environments, including the host acquisition producer's Docker grandchildren.
- Preserve private Docker configuration, local Engine selection, each caller's PATH policy and all lifetime/error bounds.
- Keep these inputs out of actual browser processes and employee containers; deliver the shared policy in image and trusted-rescue module bundles.
- Share one build-only ordinary Debian/bookworm and bookworm-updates source rewrite between verification and user images. Retain official security sources, Debian archive keyring/signature checks, suites/components, package lists, base references, DSH version and build deadlines; migrate all narrow named-context builders and examples.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `browser-runtime-verification`: verification Docker client proxy support with environment containment and an explicitly scoped build-time Debian mirror.
- `user-image`: the same approved build-time ordinary Debian mirror and unchanged runtime capability/trust boundary.

## Impact

Verification scripts, Docker command adapters, browser launch/packaging, user-image build context and integration evidence. No platform runtime configuration, base-image reference, package/DSH version, daemon configuration or provider-call changes. User-image and seccomp build-example edits are critical-path review surfaces.

## Risk triage

Issue type: bugfix.
Fixture level: expanded.
Upstream suggested level: expanded (agree: shared script/process and secret boundaries).
Blast radius: registry authentication, child environment custody and rescue packaging.
Selected risk packs: CLI/script entry; config; secrets; compatibility; error/cleanup; packaging; documentation.
Evidence floor: process/network RED/GREEN, targeted integration, static checks, exact-head original full Docker and independent host/resource inventories.
