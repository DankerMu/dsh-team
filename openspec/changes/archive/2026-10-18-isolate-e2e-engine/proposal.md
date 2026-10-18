# Proposal

## Why

`pnpm e2e` creates a fresh database but currently reconciles the configured shared Docker Engine. Issue #176 identifies a window where that reconciliation can delete another owner's newly created empty employee bridge before its canonical container exists.

## What Changes

- Provision an invocation-owned real Docker Engine and separate containerd, including their kernel network namespace, before starting the built platform; never fall back to a configured/shared socket or caller network.
- Retain real main reconciliation, health, exact migration ledger and the complete existing HTTP smoke suite.
- Own daemon, scenario and data lifetimes, including cancellation and parent loss; fail rather than claim successful incomplete cleanup.
- **BREAKING**: this verification command requires Linux, installed Docker/containerd2.x, Python3, iproute2, util-linux PID/mount/network namespace support and noninteractive sudo. Unsupported hosts fail before main; ordinary local checks and dev-server behavior remain unchanged.
- Prove separation while another real startup is held after bridge creation and before container creation; independently preserve the caller's default bridge through the private daemon lifecycle.

## Capabilities

### New Capabilities

- `built-artifact-verification`: real built-entrypoint verification with invocation-exclusive Engine ownership and bounded cleanup.

### Modified Capabilities

None. Production lifecycle and orphan reconciliation semantics are unchanged.

## Impact

`scripts/e2e.sh`, verification-only supervisor/helpers and regression tests; command prerequisites and CI-facing documentation. No new npm dependencies, image pulls, production configuration fields or host service changes. No employee startup is added to the existing read-only smoke suite.

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded for shared entrypoint, root process ownership and concurrency.
Blast radius: verification host resources and built-artifact evidence.
Selected risk packs: script entry; config/setup; file IO/path safety; permissions/secrets; concurrency/ordering; resource limits; compatibility; error/rollback; documentation.
Evidence floor: real held-start RED/GREEN, actual private-Engine e2e, fail-closed preconditions, cancellation/partial-start cleanup, focused integration checks, exact-head full Docker and CI.
