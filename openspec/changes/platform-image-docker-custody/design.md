# Design

## Context

See proposal.md. The old test-local spawnSync omits env. The canonical createDockerCommands(root, config, false) already supplies the fixed PATH, private Docker configuration, exact optional uppercase proxies and16MiB/raw-result policy.

## Goals / Non-Goals

Governing invariant: every platform-image Docker child receives only the canonical client environment, never caller credentials or ambient Docker configuration; acquisition and cleanup retain identical target authority.

Must preserve: all image/CLI/native-database/web/seccomp assertions, Docker args,30s operation and600s build deadlines, raw output/results,16MiB cap, registration-before-create and exact ownership checks.

Non-goals: changing shared proxy policy, images, daemon/services/workloads, provider calls, retries, observer exceptions or new process abstractions. #269's unmerged host-local source is not a dependency.

## Decisions

1. Replace the local adapter in place with the existing factory's unbounded/raw mode. Reject an absent launcher-owned configuration before any Docker invocation; never fall back to ambient configuration. No new exported helper or parallel environment implementation.
2. The user selected canonical SIGKILL at the existing timeout instead of preserving the old implicit SIGTERM. This is the sole intentional timeout-policy difference; no deadline increase or successful-output redaction.
3. A disposable Node loader invokes the actual test callback and substitutes only Vitest registration/host qualification and the external Docker executable. Its real child reports custody predicates without values. The pre-change caller must fail on inherited canaries/configuration; the replacement must pass. This wiring proof is not a permanent source/options test.
4. Reuse docker-proxy.integration.test.ts and relevant docker-version integration coverage for real-process transport, configuration, overflow and deadline behavior. On trusted giap-vps, run the actual platform-image Docker test with generated nonsecret environment canaries and a distinct owned ambient Docker configuration, then original full Docker/Compose discovery. No remote Engine override is supplied to the root launcher.

## Risks / Trade-offs

[Missing private config] → fail before Docker instead of selecting a user's credentials.
[Canonical termination differs] → explicitly approved SIGKILL; retain timeout values and process/result regression coverage.
[Substituted executable is not Docker] → label local smoke limits; actual image assertions and exact-owned cleanup require trusted runtime proof.
[Raw output remains raw] → do not put proxy values into args/logs; preserve the existing output contract and use no secret values in canary probes.

## Migration Plan

Atomic caller cutover; normal reviewed revert is rollback. No persisted state or host migration. Human rule-file review stays deferred and UNPASSED.
