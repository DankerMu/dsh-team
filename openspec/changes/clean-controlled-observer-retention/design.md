# Context

`createDeploymentObservation` records `ownedRoot` and the root's `{device, inode, owner}`. `finishDeploymentObservation` sets `retired = true` after writer/request settlement, then removes the root only when `ownedRoot && scenarioSucceeded`, after rechecking that identity and mode 0700; any error becomes `Deployment observation unconfirmed; retained <dir>`. Under custody the root belongs to the outer verifier (`ownedRoot=false`).

# Goals and non-goals

Governing invariant: a retained root is removed only by its owning test, only after that test's assertions establish the failure was the controlled expectation, and only after the existing identity fence.
Non-goals: changing genuine-failure retention, custody roots, observer settlement, setup evidence, deadlines or assertions; any discovery-based, prefix or global `/tmp` cleanup.

# Decisions

1. Extract `removeRetiredObservationRoot(observation)` in `deployment-observer-fixture.ts`: no-op unless `observation.ownedRoot`; throws unless `observation.retired`; rechecks directory type, device, inode, owner against `observation.rootIdentity` (never a hardcoded uid; the uid1000 qualification stays in `createDeploymentObservation`) and mode 0700 exactly as today, then removes recursively. `finishDeploymentObservation`'s success branch calls it inside its existing try, so one implementation remains and its error wrapping is unchanged. The function's comment must not claim the deployment lock is held: test callers run after `withDeployment` released it.
2. `deployment.docker.test.ts` failure-path drain regression captures `deployment.observation` from `configureDeployment`. `withDeployment` finishes the observation before returning, and the existing `primary.errors === [fault]` assertion already proves retirement succeeded (a failed finish would add a second error). Removal runs after the existing `finally` (helper/target cleanup) and only when `failures` is empty; a missing captured observation is a failure; a removal error joins `failures` before the existing aggregate throw. Any assertion or cleanup failure therefore retains the root.
3. `deployment-audit-stop.docker.test.ts`'s `withDeployment` wrapper wraps `start` to capture the returned `deployment.observation` into the hoisted `control`, reset in `beforeEach`. Only the overdue-stop case removes it, after its captured rejection carries the `audit-error-retirement` phase message, its `setup.cleanup` snapshot reports `deploymentDrain`, `resources` and `observation` all `confirmed`, and the existing envelope assertions pass (the slow case's root is already removed by a successful finish). `verifyDeployedCredentialPrivacy` rethrows a fixed phase message for any `withDeployment` failure and observation retirement is set even when drain or resource cleanup failed, so the phase message alone does not prove the controlled expectation: the confirmed-cleanup snapshot and `retired === true` (via the function) are new assertions that may expose a previously masked failure; that is intended and fails the test, retaining the root. A missing captured observation is also a failure. Under custody (`ownedRoot=false`) both test calls are no-ops.
4. Errors keep fixed messages; no path or raw cause enters setup evidence.

# Verification

Docker-free regression in new `platform/test/deployment-observer-fixture.integration.test.ts` (integration project) with real private directories under a temporary prefix that is not `/tmp/dsh-team-observer-`: removes a retired owned 0700 root; no-op for `ownedRoot=false`; refuses unretired, replaced (different inode), wrong mode, symlink or non-directory roots and leaves them in place. Existing deployment-setup/observer integration suites stay green. Trusted evidence: `/tmp/dsh-team-observer-*` inventory identical before and after a standalone `pnpm test:deploy` (drain regression removal path) and before and after a direct non-custody `pnpm test:docker platform/test/deployment-audit-stop.docker.test.ts` (overdue-case removal path); full custody `pnpm test:docker` proves the no-op custody path and no regression; independent resource observation.

# Risks

[Removing evidence of a real regression failure] → removal only runs after all assertions in the same test pass. [Deleting a foreign path] → captured object only, existing identity fence, `ownedRoot` gate. Rollback is a normal revert.
