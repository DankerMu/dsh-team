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

Verification Docker CLI processes MUST receive caller-supplied uppercase `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` when present, preserving their exact strings including empty values and omitting absent inputs. The host acquisition producer MUST preserve these inputs only to configure its Docker descendants. Existing PATH and invocation-owned Docker configuration policies, local Engine restrictions, deadlines, output bounds, closure and cleanup authority MUST remain unchanged. Unrelated environment credentials and remote Engine selectors MUST NOT be admitted by this support. Proxy values MUST NOT be logged or injected into actual browser processes or employee containers.

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

### Requirement: Verification image mirror selection preserves Debian trust and acceptance

The verification browser image SHALL obtain ordinary Debian bookworm and bookworm-updates packages through the user-approved Tsinghua Debian mirror while retaining the original official Debian security source. The source change MUST preserve Debian archive signature and validity checks, the shipped keyring, suites, components, package list, pinned base-image digest and existing600-second provisioning deadline. It MUST NOT inject runtime proxy configuration. The separately approved user-image build policy MUST share the same canonical build-only rewrite. Unexpected source layout or unavailable/invalid repository metadata MUST fail rather than silently weakening trust or falling back.

#### Scenario: Ordinary verification dependencies use the approved mirror

- **WHEN** the delivered verification image builds from its pinned base
- **THEN** only the ordinary Debian source changes, the official security source and trust configuration remain intact, and the existing full Docker command must complete provisioning within its unchanged deadline before consumer acceptance

#### Scenario: The expected source or signed metadata is invalid

- **WHEN** the expected ordinary source is missing or duplicated, or repository authentication fails
- **THEN** the build fails without disabling authentication, changing the base digest, increasing the deadline or reporting successful acceptance
