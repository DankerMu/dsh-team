## MODIFIED Requirements

### Requirement: Verification Docker proxy inputs remain confined to client transport

For ordinary verification outside a restricted trusted-model invocation, Docker CLI processes MUST receive caller-supplied uppercase `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` when present, preserving their exact strings including empty values and omitting absent inputs. Restricted trusted-model invocations MUST instead use their approved host-local proxy source, not ambient caller proxy values. The host acquisition producer MUST preserve the selected inputs only to configure its Docker descendants. Existing PATH and invocation-owned Docker configuration policies, local Engine restrictions, deadlines, output bounds, closure and cleanup authority MUST remain unchanged. Unrelated environment credentials and remote Engine selectors MUST NOT be admitted by this support. Proxy values MUST NOT be logged or injected into actual browser processes or employee containers.

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

## ADDED Requirements

### Requirement: Restricted model verification reads only private host-local Docker proxy configuration

A restricted trusted-model invocation SHALL select optional JSON configuration at `~/.config/dsh-team/docker-proxy.json` on the trusted host, never a caller-selected path or forwarded local value. A present source SHALL be a non-symlink regular file, owned by the nonroot Linux worker UID, mode0600 and bounded to16384 bytes; metadata and content SHALL be checked through one opened file identity. Its object SHALL permit only uppercase `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` string fields without NUL or line breaks. Nonempty proxy URLs SHALL use HTTP(S) with literal127.0.0.1 or[::1] and no non-root path, query, fragment or surrounding whitespace. Explicit empty values and NO_PROXY bypass semantics SHALL be preserved. Absence SHALL supply no restricted proxy fields; invalid configuration SHALL fail safely rather than fall back to ambient input. Proxy values and credentials SHALL NOT enter SSH transport/commands, systemd arguments, GitHub authorization secrets, general command/model-driver environments, actual browser/employee environments, logs, receipts or test artifacts. Existing one-shot admission, credential retirement and cleanup authority SHALL remain unchanged.

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

- **WHEN** the worker performs checkout, package installation, build, model-driver launch or external authorization operations
- **THEN** proxy configuration is not added to those general command environments or remote arguments
- **AND** required Docker acquisition/rescue carriers preserve only their existing narrow transport handoff, never actual browser or employee injection

#### Scenario: Independent finalization needs Docker transport

- **WHEN** an admitted invocation's independent worker retires its exact owned resources
- **THEN** it selects the same host-local configuration contract using its trusted invocation identity while retaining current ownership fences, private Docker configuration and explicit cleanup failure on invalid configuration

#### Scenario: Real Buildx transport acceptance is separately authorized

- **WHEN** an operator explicitly authorizes one real-model invocation for the final reviewed SHA
- **THEN** real Buildx token transport uses the existing host-local loopback proxy and the original model acceptance plus independent cleanup are recorded for that single invocation
- **AND** simulated Docker processes, unapproved provider calls, hidden retries, proxy provisioning or daemon changes do not satisfy this acceptance
