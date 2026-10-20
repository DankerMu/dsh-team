# Context

The worker's model driver already forwards `DSH_TEAM_CI_INVOCATION` but intentionally omits ambient proxy variables. Docker consumers share `dockerProxyEnvironment`; the acquisition producer already carries its narrowly projected Docker transport environment. See proposal.md for the missing source and scope.

# Goals and non-goals

Governing invariant: only host-owned configuration supplies restricted Docker transport; neither configuration data nor diagnostics become remote input, general-process environment or cleanup/admission authority.
Must preserve: ordinary uppercase projection, exact empty/absent semantics, PATH/private DOCKER_CONFIG, local Engine checks, existing build limits, actual browser/employee environments, model-key loader and one-shot resource/credential retirement. No proxy provisioning, daemon changes, local-owner forwarding, model retry or unapproved provider call.

# Decisions

1. Fixed source: `~/.config/dsh-team/docker-proxy.json` on the trusted host, resolved from its trusted home, never an SSH/request/command-line selected path. JSON rather than executable env syntax; no new service/credential-manager dependency. The implementation does not install or rewrite this file.
2. Optional absence means no proxy fields for the restricted path, never fallback to ambient proxies. A present file must be a non-symlink regular file owned by the current nonroot Linux worker UID, exactly0600 and at most16384 bytes. Open without following the leaf symlink and without blocking on special files; inspect and bounded-read the same descriptor; always close it. Invalid ownership/type/mode/size/content produces a fixed credential-free error before Docker/provider work.
3. The object permits only `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, all strings without NUL/CR/LF. Preserve exact values. An empty URL explicitly disables that proxy, matching the existing projection contract. Nonempty proxy URLs must be HTTP(S), have literal host127.0.0.1 or[::1], no non-root path/query/fragment or surrounding whitespace. URI credentials are permitted only in this private local source and never copied into artifacts. NO_PROXY retains standard explicit bypass semantics; no synthesized defaults.
4. Extend the one canonical projection using existing restricted invocation context. `DSH_TEAM_CI_INVOCATION` selects the host-local source for model descendants; the separately trusted worker normalizes its already-validated CLI invocation into that process-local context so every imported rescue client agrees. Validate the context's existing UUID shape. With no restricted context, preserve current environment behavior. Do not add standard proxies to the model-driver allowlist or change local-owner SSH/GitHub transport.
5. Each restricted projection reads a current bounded descriptor rather than introducing an implicit global cache. Atomic operator replacement is recommended; malformed in-place edits fail closed. Each returned environment is detached from the file; no secret-bearing receipt or config copy is created. Restricted host acquisition producers carry only nonsecret invocation/home context plus their existing PATH/private Docker configuration and resolve the host source for their Docker descendants; ordinary acquisition keeps its existing narrow proxy handoff. Actual Chrome/employee environments remain untouched.
6. Preserve the canonical boundary's safe error behavior. Audit root verifier, Docker command adapters, acquisition producer, independent worker rescue and driver output handling for credential leakage. Do not weaken successful output/absence contracts or suppress errors to pass privacy checks.
7. Audit both standalone packaging closures: browser image and SHA-pinned trusted worker bundle already ship the canonical helper. Any new runtime dependency must ship atomically; prefer Node builtins and in-place implementation.

# Verification and review

Seams: actual private files, public Docker command adapter with external executable substitution and owned HTTP/CONNECT servers; actual worker driver/process boundary; root verifier and standalone worker archive smoke. Positive transport must return a distinct proxy-served result rather than an environment echo. Rejection cases prove no child/network work and sanitized failure. Consumer tests prove host-local precedence, bypass/empty/absence, non-CI compatibility, file/type/owner/schema/URL rejection and no ambient/SSH/model/browser/employee leakage. Existing owner retirement tests remain unchanged and passing.
Sibling surfaces: verify-browser-runtime, probe-browser-network/runtime acquisition, docker-command, ci-vps-worker/owner/run, browser runtime/wrapper fixtures and image dependency closure. High-risk four-seat review focuses on source selection, FD identity/bounds, all process handoffs and independent finalization.

# Risks and containment

[Unavailable/malformed local configuration blocks Docker cleanup] → retain existing explicit cleanup failure/ownership receipts and lock; no ambient fallback or broader deletion authority. Correcting the operator file is a separate local operation.
[Tests use an external executable substitute] → label that evidence provider-free; final real Buildx transport and model acceptance require a separately authorized exact-SHA single invocation with independent cleanup, never a simulated substitute or retry.
[Shared helper touches non-model callers] → preserve their existing behavior and exercise current proxy/diagnostic/owner suites plus full Docker/Compose. Rollback is a normal reviewed code revert; no production schema or host service migration exists.

# Delivery gate

Implementation and provider-free verification can proceed now. The final one-shot real-model/Buildx proof and any installation of the host-local configuration require separate explicit operator authorization; do not close #269, merge or claim complete acceptance without that evidence. This is a missing execution permission, not an unresolved implementation design choice.
