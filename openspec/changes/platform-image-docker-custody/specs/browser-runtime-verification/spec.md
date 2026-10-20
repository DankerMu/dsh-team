# Spec Delta

## MODIFIED Requirements

### Requirement: Verification Docker proxy inputs remain confined to client transport

Verification Docker CLI processes MUST receive caller-supplied uppercase `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` when present, preserving their exact strings including empty values and omitting absent inputs. The host acquisition producer MUST preserve these inputs only to configure its Docker descendants. Existing PATH and invocation-owned Docker configuration policies, local Engine restrictions, deadlines, output bounds, closure and cleanup authority MUST remain unchanged. Unrelated environment credentials and remote Engine selectors MUST NOT be admitted by this support. Proxy values MUST NOT be logged or injected into actual browser processes or employee containers. Platform-image artifact verification SHALL use this same custody boundary for every Docker operation and fail before Docker work if its invocation-owned configuration is unavailable; its existing deadline values,16MiB raw-output contract and exact-owned cleanup SHALL remain intact, with the explicitly approved canonical SIGKILL timeout termination.

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
