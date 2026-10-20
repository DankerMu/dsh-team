# Proposal

## Why

Issue #301 blocks the #273 archive CI: an existing documented command was reported absent despite its manifest entry. The actual gate has a deterministic valid-input counterexample: extending the manifest with unrelated valid scripts yields printf/grep statuses141/0 under pipefail, so a successful early match becomes false rejection.

## What Changes

- Retain strict shell failure policy but consume the full command inventory with exact literal matching.
- Extend the existing disposable guardrail fixture with a large valid inventory; preserve rejection of missing commands and prove a prefix is insufficient.
- Document the invariant and keep the archive-only PR300 separate. No retry-to-green, gate weakening or new parser abstraction.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `guardrail-verification`: command inventory membership remains exact and independent of unrelated inventory growth.

## Impact

scripts/check-agents-commands.sh, existing test-guardrails.sh and AGENTS guidance. No production runtime, Docker policy, dependency or workflow change.

## Risk Triage

Issue type: bugfix. Fixture level: expanded (blocking CI/script contract). Selected packs: script-entry, config, resource/stream termination, compatibility, error handling, documentation. Evidence floor: original real-gate RED with141/0, permanent guardrail RED/GREEN, full supported Bash3.2/Bash5 self-test, canonical lint and unchanged trusted acceptance. Parent-inline coupled implementation/fixture admission; four independent review lenses follow. Original CI's exact signal remains unobserved and is not retroactively asserted.
