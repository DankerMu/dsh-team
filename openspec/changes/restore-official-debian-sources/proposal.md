# Proposal

## Why

The user explicitly selected “改回官方源” after local Linux/amd64 user/browser builds failed in APT. A minimized same-base user-image comparison observed ordinary-mirror HTTP403, HTTPS without a system CA bundle, and successful update/install using the base's official Debian sources; this does not attribute historical VPS failures.

## What Changes

- Preserve both pinned images' inherited official ordinary and security repositories instead of rewriting ordinary sources to Tsinghua.
- Remove the obsolete shared rewrite helper, its helper-only tests, both Dockerfile invocations and all live `build-tools` named contexts/examples atomically.
- Preserve package/base/version pins, archive trust, nonroot runtime, narrow plugin contexts, build limits and original runtime acceptance.
- Update active source-policy requirements and operator/rule documentation; historical archives remain unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `user-image`: restore official-source construction without a source-rewrite helper.
- `browser-runtime-verification`: restore official-source verification dependencies while preserving confinement and acceptance.

## Impact

Both image Dockerfiles, user-image fixture, browser provisioner, three shell probes and live build documentation. No platform API, Compose runtime, proxy, dependency-version or provider change. Local-build/import orchestration remains separately owned by the broader user request, not silently added here. This main-based prerequisite does not reset PR309's review gate or expand its verification-only scope.

## Risk Triage

Issue type: bugfix (explicit source-policy correction).
Fixture level: expanded; upstream suggested level absent.
Blast radius: user/browser image acquisition and every named-context caller.
Selected risk packs: script-entry, configuration, secrets/trust, resource limits, packaging, examples/documentation, failure handling.
Evidence floor: original failure receipts, complete affected amd64 builds, real image/browser assertions, unchanged final exact-head trusted full-Docker gate. Critical-path and rule-file human review remains deferred/unpassed.
