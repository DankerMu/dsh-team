# Design

## Context

See proposal.md. Docker environments already have caller-specific PATH and private DOCKER_CONFIG policies. A host Node acquisition worker must retain configuration until it launches Docker, but it is not the browser process. Native browser launch currently inherits its caller's environment.

## Goals / Non-Goals

Goal: permit explicitly supplied standard Docker client proxy inputs without broad environment inheritance or container injection.
Non-goals: new proxy validation/defaults, lowercase aliases, retries, TLS/signature bypass, base-image reference/package/DSH-version changes, runtime proxy injection, provider execution, further host maintenance, #265 diagnostics or #266 history APIs. After the verification image qualified and the unchanged user image hit the same apt deadline, the user explicitly approved the ordinary-source change for both images.

## Decisions

- Add one small shared leaf projection of the three optional inputs and compose it into existing Docker environments. This avoids moving caller-specific PATH/config policy into a general browser module or duplicating allowlists.
- Preserve present strings exactly, including empty strings; omit absent values. Docker/Go owns standard proxy interpretation. Never log the projection.
- Carry the projection through the existing host acquisition producer. Do not add Docker create/run/build arguments for proxy propagation.
- Explicitly omit these three inputs from native Chrome's inherited environment. Isolated Chrome remains inside the container whose create invocation has no proxy environment injection and whose Docker configuration is invocation-owned.
- Include the new leaf in both browser build-context packaging and the SHA-pinned remote rescue archive; existing modules remain runnable without the source checkout.
- Keep all existing child closure, output limits, timeout, local-daemon rejection and resource ownership logic unchanged.
- Reuse one build-only Node script in `images/build-tools/debian-sources.mjs` to replace only the exact active ordinary Debian URI with `http://mirrors.tuna.tsinghua.edu.cn/debian`. Retain the original official `debian-security` stanza, signed-release/validity checks, keyring, suites/components and existing HTTP transport. Comments are not active source lines.
- Both Dockerfiles mount the narrow `build-tools` named context read-only for their existing apt RUN; the helper is not copied into runtime images. Update the browser provisioner, user-image fixture, all three probe builders and every live documented build example atomically. No repository-root context or proxy build argument is introduced.
- Fail before writing when the expected active ordinary URI is absent or duplicated. Exercise the actual helper CLI against real temporary source files, including comment-only and duplicate-active inputs, preserving all unrelated bytes.

## Required evidence

- Real external-process boundary and owned HTTP endpoint distinguish proxy routing from direct routing and NO_PROXY bypass; no external network or Docker daemon in integration tests.
- Credential/remote-engine canaries cannot reach the Docker child; both sync and async paths retain private config and PATH policy. Absent/empty cases retain standard semantics.
- Native launch rejects proxy inheritance; packaged isolated browser/user-container inspection confirms no proxy injection during original full Docker verification.
- Trusted giap-vps runs the original full Docker command on the reviewed head with only authorized proxy inputs. Independent cleanup, caller bridge and original workload snapshots remain unchanged.
- Actual pre-change browser and user-image builds failed in apt at600s; the browser-only mirror already built and qualified real Chrome. The shared change still requires fresh delivered-image builds and original full Docker on the final head. No prewarming a failing layer or longer timeout may substitute. Critical-path user-image and seccomp-documentation diffs require line-by-line human review; do not claim that review performed by an agent.

## Risks / Trade-offs

- Proxy URLs can contain credentials → never print values, arguments or raw environment in evidence.
- New leaf omitted from a standalone bundle → exercise packaged runtime and rescue-module loading, not only repository imports.
- Local subprocess substitute is not Docker's Go authentication stack → real pinned-image build and original full Docker are mandatory final acceptance, not replaced by integration GREEN.
- Alternate mirror freshness/availability → keep APT signed Release/validity verification and the official security URI; fail normally on unavailable or invalid metadata. The change affects construction of browser and user images, never runtime network isolation or installed capability/version policy.

## Migration Plan

Atomic caller and packaging update, no stored-data migration. Merge #267 before rebasing/resuming #176. Revert this commit to remove client support; do not alter the separately authorized host proxy override as part of repository rollback.

## Execution sequence

1. Move the existing ordinary-source rewrite into one build-only helper and prove real-file positive/rejection behavior through the CLI; no duplicate implementation remains.
2. Atomically migrate both Dockerfiles and every named-context builder/example. Preserve the narrow context boundary and remove the former inline browser implementation.
3. Run focused integration/static checks, independent cross-review and critical-path human review; then freeze the candidate for actual targeted user-image and original full Docker acceptance with durable remote logs and exact ownership.
4. Revert the source/context change as one unit if rejected; no host proxy/DNS rollback or data migration is coupled to repository rollback. PR264 remains parked until this prerequisite merges.
