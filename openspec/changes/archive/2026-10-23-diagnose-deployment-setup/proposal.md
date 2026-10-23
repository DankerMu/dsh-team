# Proposal

## Why

Issue303 records real trusted full-Docker failures hidden behind the privacy fixture's single `setup` label. The failure recurred during issue288 qualification on head068697bffd5aa30fd007d5feab9d54e29e861d93; the stop fault was never reached, and the discarded setup exception cannot be reconstructed from later green runs. The user explicitly admitted303 to the remaining-issue queue.

## What Changes

- Record bounded closed-set setup progress at the existing deployment lifecycle and administrator configuration owners, distinguishing the entered operation from the last completed boundary.
- Project setup failure to fixed phase/reason facts without raw exceptions, command arguments/output, generated credentials, proxy values or environment snapshots. Preserve rejection and independent cleanup failures; observation never changes execution order or authorizes cleanup.
- Prove sensitivity and secrecy using actual fixture boundaries and canary-bearing adverse inputs before trusted diagnosis. Retain original full Docker discovery, both audit-stop cases and standalone Compose acceptance.
- Investigate any reproduced failure at its first observed boundary; implement only a demonstrated causal correction. Historical causes remain explicitly unknown when evidence was not retained.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `deployment`: add safe setup-boundary evidence for deployment verification without changing production deployment or existing audit-stop acceptance.

## Impact

Verification-only deployment/account/privacy fixtures, their contract consumers and regressions, and operator evidence guidance. No production server, image, proxy policy, real-model lane, deadline, retry, test selection or cleanup-authority change.

## Fixture Level and Risk

Issue type: bugfix. Fixture level: expanded. Upstream suggested level: absent; expanded because shared verification entrypoints carry secret-bearing failures and cleanup ordering. Blast radius: diagnostic leakage or a misleading setup/retirement verdict. Selected risk packs: Public API / CLI / script entry; Schema / columns / units / field names; Auth / permissions / secrets; Concurrency / shared state / ordering; Resource limits / large input / discovery; Legacy compatibility / examples; Error handling / rollback / partial outputs; Documentation / migration notes. Evidence floor: real-boundary RED/GREEN, outside-runner smoke, local fast/full integration, trusted original Docker/Compose and independent retirement/host evidence.

Reviewer lenses are separate from risk packs: correctness, invariant-state, test-evidence+spec-compliance, security-perf+integration.

## Must Preserve

Exact ownership and fixed-name refusal, registration before mutation, graceful owner drainage before resource cleanup, original error rejection, original30s stop envelope and ordinary15s observations, exact audit/privacy assertions, no provider invocation, no shared Buildx history, and unchanged host daemon/bridge/unrelated workloads. Neither cleanup nor later success turns a failed invocation into acceptance.
