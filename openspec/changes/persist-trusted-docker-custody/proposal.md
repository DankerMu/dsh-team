# Proposal

## Why

Issue #274 observed a local SSH timeout while the real full-Docker verifier and build work remained alive, without a recoverable full test verdict. Trusted verification needs invocation-bound remote ownership and durable output/results rather than treating the observing connection as the job.

## What Changes

- Add one ordinary trusted-Docker custody entrypoint for starting the unchanged full command, reconnecting to status/output, and explicitly requesting cancellation by invocation identity.
- Persist private launch authority before test work, stream safe complete output, and atomically retain command exit/signal, interruption and cleanup as separate outcomes.
- Keep the remote owner independent of SSH; refuse missing or changed identity and preserve unknown settlement rather than adopting processes or resources by discovery.
- Reuse canonical process identity, atomic receipt storage, Docker journal/absence and browser receipt boundaries. Existing restricted-model authorization and owner remain untouched.

## Capabilities

### New Capabilities

- `trusted-docker-verification`: durable ownership and evidence for the ordinary trusted full-Docker command across observer disconnection.

### Modified Capabilities

None. Browser lifecycle, proxy custody and built-artifact isolation retain their existing contracts.

## Impact

Root package command, narrow verification scripts and process integration fixtures, existing operator guidance and verification inventory. No production/platform API, user image, provider, dependency or workflow changes. Full original Docker/Compose acceptance and independent protected-host observation remain mandatory.

## Risk Triage

Expanded fixture; high risk. Packs: script-entry, configuration/environment custody, process concurrency/termination, filesystem/evidence integrity, resource ownership, compatibility and error handling. Evidence includes a real pnpm signal-propagation counterexample, permanent lifecycle RED/GREEN, real SSH disconnect/reconnect while owned work is live, nonzero verdict preservation, canary exclusion, identity-mismatch refusal and final exact-head full acceptance. Human review remains deferred and UNPASSED.
