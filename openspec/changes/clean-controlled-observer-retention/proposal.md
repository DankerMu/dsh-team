# Why

#274 added deployment observation: without `DSH_TEAM_VERIFICATION_SUBMISSIONS` the fixture owns a private `/tmp/dsh-team-observer-*` root and `finishDeploymentObservation` removes it only when the scenario succeeded, retaining it as failure evidence otherwise. Deliberately failing regressions whose failure is the asserted expectation therefore leave one 0700 root per run: every standalone `pnpm test:deploy` on the trusted host left exactly one (issue #318 recorded four such runs; three further standalone runs the same day each left one more, recorded in the trusted evidence comments of PRs #311, #295 and #320), from `deployment.docker.test.ts` failure-path drain regression; `deployment-audit-stop.docker.test.ts`'s expected-rejection case has the same shape on a direct `pnpm test:docker` (issue #318). Real failures become harder to distinguish and the shared host accumulates residue.

# What Changes

- One fixture function removes a retired, owned observation root after the same dev/inode/uid/0700 identity check `finishDeploymentObservation` already uses; the success path reuses it.
- The two controlled-failure regressions call it only after all of their own assertions pass, and only for their captured observation; failures are aggregated, never swallowed. A failing regression retains the root as evidence.
- Retention for genuine failures, custody-owned roots (`ownedRoot=false`), deadlines and assertions are unchanged; no prefix or global `/tmp` cleanup.

# Capabilities

## Modified Capabilities

- `deployment`: controlled failure regressions retire their own retained observer root.

# Impact

`platform/test/deployment-observer-fixture.ts`, `platform/test/deployment.docker.test.ts`, `platform/test/deployment-audit-stop.docker.test.ts`, plus a Docker-free regression for the removal function. No production source, schema, dependency or workflow change.

# Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (expanded: file deletion in a shared verification fixture)
Blast radius: losing genuine failure evidence, or deleting a path that is not the captured owned root
Selected risk packs: file IO/path safety; error handling/partial outputs
Evidence floor: Docker-free RED/GREEN for the removal function's identity fences; canonical checks; exact-head trusted custody Docker and standalone Compose, with `/tmp/dsh-team-observer-*` inventory unchanged across the standalone `pnpm test:deploy` and across a direct non-custody `pnpm test:docker platform/test/deployment-audit-stop.docker.test.ts`
