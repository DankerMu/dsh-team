## Why

Issue #265 records a browser image build failure before test discovery whose original process result was reduced to a generic error, while its receipt remained build-submitting. Image identity uncertainty and failed removal were then indistinguishable. Preserve safe evidence from that exact attempt without claiming its historical cause or changing deletion authority.

## What Changes

- Share the existing Docker build diagnostic projection between verification callers rather than introduce another parser.
- Persist an explicit image-build failure and bounded fixed metadata in the private image receipt, using the original process result without a retry.
- Record image cleanup confirmation, unconfirmed ownership, blocked cleanup and failed removal separately from browser-resource retirement.
- Retain build-success qualification evidence in its existing separate failure receipt; audit existing image-receipt rescue consumers without granting new authority.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `browser-runtime-verification`: image admission failure evidence and cleanup uncertainty.

## Impact

Root browser verifier, shared Docker diagnostic projection and its current caller, process-boundary integration fixtures, existing operator guidance. No production image, provider, daemon configuration, timeout, test discovery or acceptance changes.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded because this changes a shared CLI and private evidence/state publication across destructive cleanup boundaries.
Blast radius: unsafe or misleading image-retirement authority and credential-bearing build output.
Selected risk packs: CLI/script entry; file/path; schema/state; secrets; ordering/partial outputs; resource bounds; compatibility; documentation.
Evidence floor: real verifier subprocess RED/GREEN with isolated external Docker boundary and canaries; unchanged diagnostic caller regressions; trusted exact-head Compose/full Docker plus independent cleanup and retained-host fence; protected CI and archive.
