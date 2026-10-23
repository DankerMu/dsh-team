# Tasks

## 1. Fixture and executable baseline

- [x] 1.1 Record the explicit “改回官方源” decision, original local build failures, actual mirror HTTP403 and same-base official-source update/install exit0/0; retain bounded receipts in `.run/local-build-route/apt-disposition.json` without attributing historical VPS failures.
- [x] 1.2 Review this expanded fixture and run `openspec validate restore-official-debian-sources --strict --no-interactive`; require matching existing requirement names and no relaxed runtime gates.

## 2. Atomic source-policy cutover

- [x] 2.1 Remove both Dockerfile rewrite invocations, the helper and obsolete helper-only test, and all five live builder context arguments; verify untouched pins/packages/trust/runtime instructions and no remaining live helper/context consumers.
- [x] 2.2 Update active AGENTS/deployment/plugin/seccomp build guidance in the same cutover, preserving historical archives; verify documented commands and all remaining plugin/browser contexts with `pnpm check:fast`.
- [x] 2.3 Run the existing Docker build diagnostic, browser build and user-image lifecycle integration regressions through `pnpm test:integration`; require unchanged failure propagation, ownership and runtime discovery rather than Dockerfile-text assertions.

## 3. Frozen-artifact acceptance

- [x] 3.1 After code review, build both complete Linux/amd64 images with their actual candidate Dockerfiles and narrow contexts; record source/image identities, effective inherited ordinary/security source and trust configuration, package acquisition success and existing deadlines. A package-only probe or cached tag is not complete image evidence.
- [x] 3.2 The separately owned #315 acquisition route is delivered atomically in PR314: original commands consumed source-bound uploaded OCI artifacts through metadata-only case derivation, with independent cleanup and retained failure evidence. No VPS dependency rebuild was substituted for imported-artifact acceptance.
- [x] 3.3 Obtain the unchanged original exact-head full `pnpm test:docker` acceptance and required CI contexts before merge; explicitly report source/import path and any blocker. Do not claim a narrower smoke, historical head or model authorization as equivalent evidence.

Accepted head `a5af7cc71ac5496d1aa87624f355ff75c36920f1`: full Docker108/33, standalone deployment11/1, same-head full stability108/33; all exit0 and independent retirement. PR314 merged as `c5d3a726b51d1daabc253981e278a7a24dc0fde2`; [durable exact-head evidence](https://github.com/DankerMu/dsh-team/pull/314#issuecomment-6343141055). Human review remains deferred/unpassed.

## Risk-pack map

- Selected script-entry/configuration: tasks2.1–2.3 cover all five builders and original argument/failure boundaries; no new runtime configuration.
- Selected trust/secrets: tasks2.1/3.1 preserve official security source, keyring/signature/validity and credential isolation; no proxy inputs in layers or trust bypass.
- Selected resource-limits/failure-handling: tasks2.3/3.1–3.3 retain600s/16MiB limits, original nonzero outcomes, exact-owned cleanup and full discovery.
- Selected packaging/examples/documentation: tasks2.1–3.3 cover both images, all narrow contexts, live examples and real runtime contracts.
- File-writer compatibility: old source mutation and its tests are intentionally removed, not replaced by a no-op. No new file-format parser, shared-state protocol, schema, API or authorization surface.
- Human critical-path/rule-file review remains deferred/unpassed by the user's separate decision; automated review and runtime gates are not waived.
