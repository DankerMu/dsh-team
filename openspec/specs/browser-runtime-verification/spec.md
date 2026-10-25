# browser-runtime-verification Specification

## Purpose

Make browser runtime failures attributable without changing the behavior being verified, exposing credentials or weakening acceptance. Qualification must distinguish a genuine owner-level repair from a passing diagnostic, stale candidate evidence or an ignored network failure.

## Requirements

### Requirement: Browser failure evidence preserves the failed exchange

When browser navigation or application readiness fails, the verifier MUST retain bounded request/response/failure context alongside its existing screenshot/control evidence. Context MUST identify the relevant request and redirect hop, safe path, resource type, observed status or failure code, cancellation state and relative timing. Evidence collection or persistence failure MUST NOT replace the original failure or turn it into success.

#### Scenario: Document succeeds but a required script fails

- **WHEN** the document receives200 and a required script fails with an uncanceled network error before application readiness
- **THEN** retained evidence distinguishes the successful document from the failed script and preserves the original nonzero acceptance outcome

#### Scenario: Evidence output fails

- **WHEN** writing failure evidence fails after the browser scenario has already failed
- **THEN** the original scenario failure remains authoritative and the evidence failure is reported safely without claiming complete evidence

### Requirement: Evidence is private, bounded and honest about loss

Persisted diagnostic evidence MUST exclude credentials, cookies, headers, URL queries, response bodies and raw network-address inventories. Collections MUST have explicit bounds and report drops or collector failures. Host/Docker correlation MUST retain enough selected identity and timing provenance to distinguish owned, foreign and unresolved events; unresolved identity MUST NOT be labelled foreign merely because it was not registered.

#### Scenario: Sensitive traffic and excess events

- **WHEN** traffic contains secret-bearing fields or exceeds the evidence limit
- **THEN** those fields are absent from persisted evidence, retained rows remain within the declared bound, and loss is explicitly counted

#### Scenario: Attribution is incomplete

- **WHEN** a host event is near a browser failure but the interface or resource owner cannot be established
- **THEN** the report records an unresolved correlation rather than a causal-owner conclusion

### Requirement: Observation preserves all existing consumers

Adding diagnostics MUST NOT replace another observer's events, change navigation or startup timing policy, alter successful acceptance semantics, or suppress original failures. Session creation receipts, model-refusal checks, permission checks and owned-resource cleanup MUST retain their existing guarantees.

#### Scenario: Multiple browser evidence consumers

- **WHEN** failure collection and a scenario-specific observer consume the same protocol event
- **THEN** both receive the required event information and the scenario retains its original success or failure result

### Requirement: A blocker repair requires causal and behavioral proof

The verifier's network blocker MUST be repaired at a demonstrated owner. A successful isolated or instrumented run, temporal proximity, extra retries, increased deadlines, arbitrary delay or ignored browser error MUST NOT qualify as a repair. Experimental mutations MUST affect only newly created invocation-owned test resources.

#### Scenario: A controlled cause is removed

- **WHEN** a discriminating owned-resource scenario establishes the interruption mechanism and a repair is applied
- **THEN** the original failing behavior no longer occurs under that scenario, the unchanged real browser acceptance passes, and unrelated resources remain unchanged

#### Scenario: The authorized diagnosis bound is reached

- **WHEN** the approved bounded round ends without causal repair and required evidence
- **THEN** the workflow remains blocked with retained failures instead of retrying until green or declaring the blocker complete

### Requirement: Verification browser networking is isolated without bypassing the real endpoint

Trusted Linux Docker browser verification MUST run Chrome in an invocation-owned stable network namespace, separate from host interface churn. Application and CDP transport MUST preserve original loopback port numbers, URLs, authority, cookie scope and raw HTTP/WebSocket bytes through one-to-one owned relays. The driver and real platform endpoint MUST remain on their existing side of the boundary; first-use MUST still exercise platform authentication and gateway forwarding. Runtime selection and image/browser identities MUST be explicit, with no silent host-browser fallback.

#### Scenario: Host topology changes while a required script is queued

- **WHEN** the controlled occupied-connection and observed High-priority target preconditions hold and the original owned host bridge/address transition occurs
- **THEN** the isolated browser target receives HTTP200, the original readiness/error gates pass, and independent evidence confirms the host transition and separate browser network identity

#### Scenario: Isolation prerequisites are missing

- **WHEN** isolated runtime is requested on an unsupported platform or its image, browser or namespace transport cannot start
- **THEN** startup fails explicitly, no native fallback occurs, and acquired owned resources are independently cleaned

#### Scenario: Browser application observes network availability

- **WHEN** the unchanged browser client starts on the private internal bridge
- **THEN** the browser naturally reports online without a JavaScript/CDP override or notification-disabling flag, while the namespace has no IPv4 default route, no IPv4 bridge gateway and no non-loopback IPv6 interface; owned-host reachability probes fail and original relayed authentication, session initialization and reload remain usable

#### Scenario: Browser runtime renders Chinese controls

- **WHEN** the pinned browser renders the real Chinese first-use surface in the verification image
- **THEN** runtime font coverage renders readable Chinese glyphs without host font-directory mounts or changes to product localization

### Requirement: Browser termination ownership survives partial startup and driver failure

The canonical launcher MUST register and retain private ownership information before partially creating isolated resources. Normal stop, setup failure and outer timeout/signal rescue MUST clean the exact owned browser/container, dedicated internal network, relay sockets and listeners. Cleanup MUST settle outstanding creation before claiming absence, verify immutable resource identity and network ownership/configuration, and MUST NOT interpret an internal container PID or Docker client PID as a host Chrome PID, delete foreign resources, disconnect unexpected network peers, or replace the primary failure with a success.

#### Scenario: Driver stops before returning a browser handle

- **WHEN** the driver exits or is killed after isolated resource acquisition but before setup returns
- **THEN** the independent outer cleanup owner can use the retained receipt to retire only matching owned resources and verify their absence

#### Scenario: Cleanup identity differs

- **WHEN** the name, immutable identity, ownership marker or expected image does not match the retained launch identity
- **THEN** cleanup refuses destructive action and reports incomplete cleanup rather than claiming success

#### Scenario: Creation succeeds before immutable identity is recorded

- **WHEN** the driver dies after container creation while the private pre-create receipt still explicitly has no recorded container ID
- **THEN** rescue may adopt an inspected ID only after exact registered name, nonce/run ownership and expected immutable image match, atomically record it and clean by ID; an already-recorded ID is never replaced

#### Scenario: Network acquisition is interrupted

- **WHEN** the driver dies after private network creation but before recording its ID or creating the browser
- **THEN** rescue settles the producer and adopts only an explicitly pending network with exact name, nonce/run and isolated configuration, atomically records its ID and removes it after verifying no unexpected endpoints; an existing recorded ID is never replaced and foreign peers cause refusal

### Requirement: Runtime qualification binds to the final candidate

Final acceptance MUST use the original full test discovery and existing error/deadline gates on the final exact candidate, with complete environment identity and owned-resource cleanup. For this intermittent failure, one planned same-candidate stability run MUST follow the first successful full qualification. Diagnostic variants and older-candidate results MUST remain separately labelled and MUST NOT be substituted for final evidence.

#### Scenario: A diagnostic passes while original acceptance fails

- **WHEN** an instrumented or isolated scenario passes but the original full suite fails on the final candidate
- **THEN** the candidate remains unqualified and both outcomes are retained

### Requirement: Verification Docker proxy inputs remain confined to client transport

For ordinary verification outside a restricted trusted-model invocation, Docker CLI processes MUST receive caller-supplied uppercase `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` when present, preserving their exact strings including empty values and omitting absent inputs. Restricted trusted-model invocations MUST instead use their approved host-local proxy source, not ambient caller proxy values. The host acquisition producer MUST preserve the selected inputs only to configure its Docker descendants. Existing PATH and invocation-owned Docker configuration policies, local Engine restrictions, deadlines, output bounds, closure and cleanup authority MUST remain unchanged. Unrelated environment credentials and remote Engine selectors MUST NOT be admitted by this support. Proxy values MUST NOT be logged or injected into actual browser processes or employee containers. Platform-image artifact verification SHALL use this same custody boundary for every Docker operation and fail before Docker work if its invocation-owned configuration is unavailable; its existing deadline values,16MiB raw-output contract and exact-owned cleanup SHALL remain intact, with the explicitly approved canonical SIGKILL timeout termination.

#### Scenario: Client authentication requires an explicitly configured proxy

- **WHEN** verification supplies standard proxy inputs and Docker's client-side registry authentication uses that proxy
- **THEN** the client can complete the exchange while retaining its private Docker configuration and excluding unrelated credentials

#### Scenario: Proxy bypass or absence is intentional

- **WHEN** NO_PROXY excludes a destination, or proxy inputs are absent or explicitly empty
- **THEN** the Docker client receives exactly that configuration without a synthesized fallback and retains its standard direct/bypass behavior

#### Scenario: Host acquisition and isolated execution are distinct

- **WHEN** a host acquisition worker creates a verification browser or a verifier creates an employee container
- **THEN** Docker descendants retain client proxy configuration but actual browser and employee environments do not receive those proxy inputs

#### Scenario: Standalone verification artifacts run without the checkout

- **WHEN** the browser image or SHA-pinned trusted rescue bundle runs without repository source mounts
- **THEN** its complete runtime dependency closure loads and existing owned-resource cleanup remains available

#### Scenario: Platform image verification starts from a credential-bearing shell

- **WHEN** the trusted platform-image test runs with nonsecret credential canaries and a different ambient Docker configuration
- **THEN** its actual Docker children receive only approved client fields and the invocation-owned configuration, all existing standalone artifact checks pass, and cleanup retires only invocation-owned resources without changing unrelated host workloads

#### Scenario: Platform image verification has no invocation configuration

- **WHEN** the platform-image test lacks its launcher's private Docker configuration
- **THEN** it fails before starting Docker rather than using caller or default user configuration

### Requirement: Verification image official sources preserve Debian trust and acceptance

The verification browser image SHALL retain its pinned base's original official Debian bookworm, bookworm-updates and security sources rather than forcibly selecting a third-party mirror. Construction MUST preserve Debian archive signature and validity checks, the shipped keyring, suites, components, package list, pinned base-image digest and existing600-second provisioning deadline. It MUST NOT inject runtime proxy configuration. The separately approved user-image build policy MUST use the same official-source policy without a shared source-rewrite mechanism. Failed repository authentication or inability to complete dependency installation MUST fail rather than weakening trust, silently falling back or reporting successful acceptance.

#### Scenario: Ordinary verification dependencies use official repositories

- **WHEN** the delivered verification image builds from its pinned base
- **THEN** ordinary sources, the official security source and trust configuration remain intact without an auxiliary source-rewrite context, and the existing full Docker command must complete provisioning within its unchanged deadline before consumer acceptance

#### Scenario: Official dependency acquisition fails

- **WHEN** official repository acquisition or authentication prevents dependency installation from completing
- **THEN** the build fails without disabling authentication, selecting a different mirror, changing the base digest, increasing the deadline or reporting successful acceptance

### Requirement: Browser image admission failures retain safe attempt evidence and cleanup uncertainty

The browser verification entrypoint SHALL retain a private terminal image-build failure receipt from the original failed build attempt, containing only bounded fixed process classifications and allowlisted build-phase metadata. It SHALL distinguish image ownership that cannot be confirmed from a failed authorized removal and from confirmed cleanup. Evidence SHALL NOT expand deletion authority, alter existing deadlines or discovery, retry a build, expose raw output or credentials, or identify an unproved historical build cause.

#### Scenario: Image build fails before verification discovery

- **WHEN** the original image build exits unsuccessfully, cannot start, exceeds its existing output bound or reaches its existing deadline
- **THEN** the invocation retains an explicit image-build failure state and safe process outcome from that attempt
- **AND** the command exits nonzero without entering test discovery, qualification or another build attempt

#### Scenario: Failure output contains secrets or arbitrary error metadata

- **WHEN** a failed build result contains credential-bearing stdout, stderr, headers or exception properties
- **THEN** persisted receipts and terminal output contain only fixed allowlisted diagnostic fields, never those input values or raw errors

#### Scenario: Image ownership cannot be confirmed

- **WHEN** image inspection is absent, fails, has no valid immutable identity, has a foreign invocation label or observes a changed tag identity
- **THEN** cleanup records ownership as unconfirmed and performs no image removal on that evidence
- **AND** neither an empty inventory nor a missing tag becomes successful retirement authority

#### Scenario: A failed build leaves a verified owned image

- **WHEN** the failed attempt has an independently verified current invocation-owned immutable image and existing browser-resource cleanup permits removal
- **THEN** only that exact image may be removed and its cleanup outcome is recorded separately from the failed build
- **AND** successful cleanup does not convert build failure into verification success; a failed authorized removal remains an explicit cleanup failure

#### Scenario: Browser cleanup is not confirmed

- **WHEN** invocation-owned browser rescue cannot confirm retirement
- **THEN** the image is retained with blocked cleanup and the overall invocation remains nonzero

#### Scenario: Qualification fails after a successful image build

- **WHEN** the image build succeeds and subsequent browser qualification fails
- **THEN** the existing qualification failure receipt identifies that later phase and is not replaced or mislabeled as image-build admission failure

#### Scenario: Evidence publication fails

- **WHEN** a required image failure or cleanup receipt cannot be published
- **THEN** the entrypoint reports a fixed sanitized evidence failure and remains nonzero without claiming a durable confirmed outcome

### Requirement: Process generation authority is independent of observer display and executable presentation

Verification process ownership SHALL identify the same live process generation independently of observer locale, timezone, command display and an executable transition within that generation. Identity SHALL include kernel generation evidence sufficiently precise to distinguish process births; PID alone, second-resolution start display and repeated display stability SHALL NOT authorize cleanup. Missing prerequisites, permission failures, malformed observations and unknown states SHALL fail closed. Existing Linux kernel-start and zombie/absence semantics SHALL remain unchanged.

#### Scenario: An owned process changes executable or command presentation

- **WHEN** a still-live invocation-owned process changes its executable or command presentation after its birth identity is captured
- **THEN** observers retain the same generation identity without a delay or recapture workaround, and different live process generations remain distinguishable

#### Scenario: Observers use different display environments

- **WHEN** observers query the same owned live process using different locale and timezone settings
- **THEN** they obtain the same generation identity and preserve an unrelated live sentinel

#### Scenario: Current identity cannot be established

- **WHEN** the kernel observation is unavailable, denied, malformed or has an unsupported process state
- **THEN** verification reports unknown identity and does not signal a guessed process or authorize resource cleanup from supposed owner absence

### Requirement: Obsolete Darwin receipt identity cannot authorize cleanup

A persisted Darwin display-hash process identity from the previous representation SHALL be rejected as unsupported authority before any comparison can establish owner absence, PID reuse, producer settlement or cleanup permission. Verification SHALL preserve the receipt and associated private resources on this refusal. It SHALL NOT translate, overwrite or adopt the old identity using a current PID observation. This restriction SHALL apply to drivers, acquisition producers and external native process ownership, without weakening issued in-memory child ownership or existing immutable resource checks.

#### Scenario: A live driver has a pre-change receipt

- **WHEN** external rescue reads a pre-change Darwin identity for a still-live driver
- **THEN** it refuses before process signalling or resource retirement, retains the receipt and leaves both the driver and unrelated sentinel untouched

#### Scenario: A producer has an obsolete identity

- **WHEN** a receipt contains a pre-change Darwin acquisition-producer identity
- **THEN** rescue cannot treat the representation mismatch as settled production or authorize dependent resource removal

### Requirement: Platform UI verification retains its public listener continuously

Platform UI verification SHALL retain unique invocation-owned listener custody continuously from choosing its public Origin until teardown. App/database construction and backend readiness SHALL NOT release and later rebind that public port. Real compiled assets, HTTP, SQLite, authentication, source-address and Origin policy, existing browser failure observers and current full UI discovery SHALL remain unchanged. Verification SHALL NOT rely on listen retries, fixed shared ports, increased deadlines or tolerated request failures.

#### Scenario: Another listener competes during initialization

- **WHEN** initialization is deliberately held after the public Origin is selected and an independent listener attempts to bind that exact address
- **THEN** the competing bind fails because the fixture continuously owns the listener, and initialization can subsequently serve real platform requests without rebinding the public port

#### Scenario: Browser requests reach the ready platform

- **WHEN** the fixture admits consumers after the real application becomes ready
- **THEN** the configured public Origin equals the continuously owned public endpoint, real same-Origin authentication/mutation succeeds, and a wrong-Origin mutation remains rejected
- **AND** raw HTTP/WebSocket bytes, cookies, backpressure and orderly stream closure retain the existing browser verification guarantees

#### Scenario: A connection arrives before readiness

- **WHEN** a socket reaches the owned public listener before backend activation
- **THEN** it is closed as an owned pre-ready connection without buffering, forwarding to an unready destination or releasing the listener

### Requirement: UI fixture teardown preserves failures and unrelated listeners

Normal completion, initialization failure and scenario failure SHALL settle every acquired invocation-owned listener, paired socket, API context and database/application resource while preserving unrelated listeners. The public listener SHALL reject activation after closure and SHALL NOT switch destinations after activation. Cleanup SHALL attempt independent owned resources even if an earlier cleanup fails, preserve the original scenario failure alongside cleanup failures and retain private paths when settlement is unconfirmed. Playwright browser/page ownership SHALL remain unchanged.

#### Scenario: Initialization or the scenario fails

- **WHEN** initialization fails after owned resources exist or the fixture callback throws
- **THEN** the original failure remains visible, owned ports become reusable only after teardown, acquired database handles are closed, and an unrelated listener remains usable

#### Scenario: Forwarding authority is changed after activation or closure

- **WHEN** a caller attempts a second destination activation or attempts activation after teardown begins
- **THEN** verification refuses the transition without reopening a listener or forwarding to the replacement destination

#### Scenario: Cleanup itself fails

- **WHEN** one owned cleanup operation fails after the scenario has failed
- **THEN** remaining independent cleanup is attempted, both failures are retained and unconfirmed resources are not reported as successfully retired

### Requirement: Build failure diagnostics recognize single-stage and padded step headers

The bounded build-failure projection SHALL recognize step headers whose stage token is `build`, `runtime` or the fixed unnamed-stage token `stage-0`, separated from `i/N` by one or more spaces, and SHALL project the literal stage token as the phase. Other stage names, out-of-range vertices and steps beyond their total SHALL remain unrecognized, and raw output SHALL still never be retained.

#### Scenario: Single-stage padded RUN header

- **WHEN** the last build header is `#15 [stage-0  2/11] RUN …`
- **THEN** the diagnostic records `{vertex: 15, phase: 'stage-0', step: 2, total: 11, instruction: 'RUN'}`

#### Scenario: Named stage padded header

- **WHEN** the last build header is `#6 [build  2/10] RUN …`
- **THEN** the diagnostic records `{vertex: 6, phase: 'build', step: 2, total: 10, instruction: 'RUN'}`

#### Scenario: Unknown stage stays unknown

- **WHEN** a header names another stage such as `[private-stage  1/1]`
- **THEN** it is not recognized and does not replace an earlier recognized header

### Requirement: Restricted model verification reads only private host-local Docker proxy configuration

A restricted trusted-model invocation SHALL select optional JSON configuration at `~/.config/dsh-team/docker-proxy.json` on the trusted host, never a caller-selected path or forwarded local value. A present source SHALL be a non-symlink regular file, owned by the nonroot Linux worker UID, mode0600 and bounded to16384 bytes; metadata and content SHALL be checked through one opened file identity. Its object SHALL permit only uppercase `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` string fields without NUL or line breaks. Nonempty proxy URLs SHALL use HTTP(S) with literal127.0.0.1 or[::1] and no non-root path, query, fragment or surrounding whitespace. Explicit empty values and NO_PROXY bypass semantics SHALL be preserved. Absence SHALL supply no restricted proxy fields; invalid configuration SHALL fail safely rather than fall back to ambient input. Proxy values and credentials SHALL NOT enter SSH transport/commands, systemd arguments, GitHub authorization secrets, general command/model-driver environments (other than the worker's exact-SHA checkout `git` child environments defined below), actual browser/employee environments, git arguments or configuration, logs, receipts or test artifacts. Existing one-shot admission, credential retirement and cleanup authority SHALL remain unchanged.

#### Scenario: Local caller and host configuration disagree

- **WHEN** a restricted invocation has valid host-local proxy settings and different ambient caller proxy values
- **THEN** only the host-local settings reach its Docker/Buildx clients and the caller values are neither forwarded nor used as fallback
- **AND** non-restricted verification retains its existing caller-projection behavior

#### Scenario: Host configuration is absent or explicitly disables a proxy

- **WHEN** the optional file is absent or an allowed proxy field is an empty string
- **THEN** restricted clients respectively omit the proxy field or receive its exact empty value, without inheriting ambient credentials

#### Scenario: Host configuration is unsafe or malformed

- **WHEN** the source is symlinked, non-regular, foreign-owned, not0600, oversized, invalid JSON, contains unknown/non-string fields, or names a non-loopback/unsupported proxy URL
- **THEN** the operation fails with a fixed sanitized configuration error before Docker/provider work and retains no raw source, URL or credential in evidence

#### Scenario: Host configuration changes between client operations

- **WHEN** the operator atomically replaces the private configuration between separate Docker client operations
- **THEN** each operation validates its own opened file identity and selected content without mixing metadata from another file or accepting a malformed partial replacement

#### Scenario: A restricted model driver launches unrelated commands

- **WHEN** the worker performs package installation, build, model-driver launch or external authorization operations
- **THEN** proxy configuration is not added to those general command environments or remote arguments
- **AND** required Docker acquisition/rescue carriers preserve only their existing narrow transport handoff, never actual browser or employee injection

#### Scenario: Exact-SHA checkout needs the host-local proxy

- **WHEN** the admitted worker fetches its approved SHA from the fixed public repository
- **THEN** only its `git` child environments receive the validated host-local proxy fields, never git arguments, git configuration files, receipts or diagnostics
- **AND** the checked-out `HEAD` must still equal the approved SHA, absence keeps direct transport, and invalid configuration fails the checkout phase before network work without exposing the source

#### Scenario: Independent finalization needs Docker transport

- **WHEN** an admitted invocation's independent worker retires its exact owned resources
- **THEN** it selects the same host-local configuration contract using its trusted invocation identity while retaining current ownership fences, private Docker configuration and explicit cleanup failure on invalid configuration

#### Scenario: Real Buildx transport acceptance is separately authorized

- **WHEN** an operator explicitly authorizes one real-model invocation for the final reviewed SHA
- **THEN** real Buildx token transport uses the existing host-local loopback proxy and the original model acceptance plus independent cleanup are recorded for that single invocation
- **AND** simulated Docker processes, unapproved provider calls, hidden retries, proxy provisioning or daemon changes do not satisfy this acceptance
