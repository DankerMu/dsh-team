# Design

## Context

See proposal.md. Docker environments already have caller-specific PATH and private DOCKER_CONFIG policies. A host Node acquisition worker must retain configuration until it launches Docker, but it is not the browser process. Native browser launch currently inherits its caller's environment.

## Goals / Non-Goals

Goal: permit explicitly supplied standard Docker client proxy inputs without broad environment inheritance or container injection.
Non-goals: new proxy validation/defaults, lowercase aliases, retries, TLS/signature bypass, base-image or production user-image changes, provider execution, further host maintenance, #265 diagnostics or #266 history APIs. The user's later explicit approval permits only the verification image's ordinary Debian mirror change below.

## Decisions

- Add one small shared leaf projection of the three optional inputs and compose it into existing Docker environments. This avoids moving caller-specific PATH/config policy into a general browser module or duplicating allowlists.
- Preserve present strings exactly, including empty strings; omit absent values. Docker/Go owns standard proxy interpretation. Never log the projection.
- Carry the projection through the existing host acquisition producer. Do not add Docker create/run/build arguments for proxy propagation.
- Explicitly omit these three inputs from native Chrome's inherited environment. Isolated Chrome remains inside the container whose create invocation has no proxy environment injection and whose Docker configuration is invocation-owned.
- Include the new leaf in both browser build-context packaging and the SHA-pinned remote rescue archive; existing modules remain runnable without the source checkout.
- Keep all existing child closure, output limits, timeout, local-daemon rejection and resource ownership logic unchanged.
- Replace only the exact ordinary Debian URI in the pinned image's deb822 source file with `http://mirrors.tuna.tsinghua.edu.cn/debian`; retain the existing official `debian-security` stanza unchanged, following the mirror's recommendation to keep security updates official. Keep the existing HTTP transport and Debian signed-release trust; do not add insecure APT flags or change certificates.
- Fail the build if the expected ordinary URI is absent or duplicated. The observed pinned source has one bookworm/bookworm-updates stanza and one separate bookworm-security stanza, both using the shipped Debian archive keyring. No new package, suite or runtime proxy field is introduced.

## Required evidence

- Real external-process boundary and owned HTTP endpoint distinguish proxy routing from direct routing and NO_PROXY bypass; no external network or Docker daemon in integration tests.
- Credential/remote-engine canaries cannot reach the Docker child; both sync and async paths retain private config and PATH policy. Absent/empty cases retain standard semantics.
- Native launch rejects proxy inheritance; packaged isolated browser/user-container inspection confirms no proxy injection during original full Docker verification.
- Trusted giap-vps runs the original full Docker command on the reviewed head with only authorized proxy inputs. Independent cleanup, caller bridge and original workload snapshots remain unchanged.
- Actual pre-change build failed in apt at600s; bounded source probes are diagnostic only. The changed delivered Dockerfile must build through the unchanged original full Docker command, which also qualifies the isolated browser and all existing consumers. No prewarming a failing layer or longer timeout may substitute.

## Risks / Trade-offs

- Proxy URLs can contain credentials → never print values, arguments or raw environment in evidence.
- New leaf omitted from a standalone bundle → exercise packaged runtime and rescue-module loading, not only repository imports.
- Local subprocess substitute is not Docker's Go authentication stack → real pinned-image build and original full Docker are mandatory final acceptance, not replaced by integration GREEN.
- Alternate mirror freshness/availability → keep APT signed Release/validity verification and the official security URI; fail normally on unavailable or invalid metadata. This source affects only verification-image construction, not production images or runtime network isolation.

## Migration Plan

Atomic caller and packaging update, no stored-data migration. Merge #267 before rebasing/resuming #176. Revert this commit to remove client support; do not alter the separately authorized host proxy override as part of repository rollback.
