## ADDED Requirements

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

The verification browser image SHALL obtain ordinary Debian bookworm and bookworm-updates packages through the user-approved Tsinghua Debian mirror while retaining the original official Debian security source. The source change MUST preserve Debian archive signature and validity checks, the shipped keyring, suites, components, package list, pinned base-image digest and existing600-second provisioning deadline. It MUST NOT alter production user images or inject runtime proxy configuration. Unexpected source layout or unavailable/invalid repository metadata MUST fail rather than silently weakening trust or falling back.

#### Scenario: Ordinary verification dependencies use the approved mirror

- **WHEN** the delivered verification image builds from its pinned base
- **THEN** only the ordinary Debian source changes, the official security source and trust configuration remain intact, and the existing full Docker command must complete provisioning within its unchanged deadline before consumer acceptance

#### Scenario: The expected source or signed metadata is invalid

- **WHEN** the expected ordinary source is missing or duplicated, or repository authentication fails
- **THEN** the build fails without disabling authentication, changing the base digest, increasing the deadline or reporting successful acceptance
