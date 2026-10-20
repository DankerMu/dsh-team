# Proposal

## Why

The canonical Darwin process identity hashes locale-sensitive start-time and mutable command display text. Actual owned-process observations prove observer-locale disagreement and same-PID command changes during executable startup; this blocks trustworthy #274 custody verification and risks treating a live old-receipt owner as absent (#304).

## What Changes

- Replace Darwin display-text identity with an immutable, precise kernel process-birth observation, using the existing canonical helper rather than a second implementation.
- **BREAKING**: reject pre-change Darwin display-hash receipts as unsupported authority before any cleanup inference; never translate them to a new identity or infer owner death from representation mismatch.
- Preserve Linux kernel-start identity, absence/zombie semantics and unknown-observation refusal.
- Add actual owned-process regressions for locale/timezone, executable or command changes, old-receipt refusal, different births and unrelated-sentinel preservation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `browser-runtime-verification`: stable process-generation authority and fail-closed handling of obsolete Darwin receipts.

## Impact

Canonical native process observations and receipt consumers, their process-boundary integration tests, verification runtime closure and prerequisite documentation. No DSH, image, provider, daemon, proxy, execution-deadline or Docker deletion-policy change. Existing receipts are retained for explicit operator resolution rather than silently adopted.

## Fixture Contract

Expanded fixture; ownership/lifecycle, compatibility and evidence risk packs. Required evidence includes failing-before/passing-after actual subprocess observations, current local integration consumers, Linux identity/cleanup consumers and final reviewed-head trusted Docker acceptance with independent owned-resource and unrelated-host checks. Human review remains deferred and unpassed. The parent performs this coupled implementation inline under the session's higher-priority delegation policy; independent cross-review remains required.
