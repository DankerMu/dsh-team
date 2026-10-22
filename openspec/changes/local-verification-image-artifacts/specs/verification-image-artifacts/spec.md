## ADDED Requirements

### Requirement: Optional trusted uploaded-image acquisition

Existing verification builders SHALL accept an explicit private mapping of trusted operator-prepared user, platform and browser OCI layouts. Unset selection SHALL preserve native acquisition. Selected empty, missing or invalid inputs SHALL fail without native fallback. The adapter SHALL verify bounded private manifest/config inputs and their exact digests and Linux/amd64 identity before image mutation.

#### Scenario: Broken explicit selection

- **WHEN** an empty or missing mapping is selected
- **THEN** no native build or verification child starts
- **AND** existing native build-failure cases remain unchanged when no mapping is selected

#### Scenario: Invalid artifact identity

- **WHEN** selected manifest/config digest, role or platform identity is invalid
- **THEN** acquisition rejects rather than rebuilding dependencies on the VPS

### Requirement: Case ownership and content preservation

Artifact acquisition SHALL establish an absent case tag before granting cleanup ownership, derive a case-owned image from the exact local OCI manifest, and verify complete Config/RootFS equivalence except declared labels before runtime use. It SHALL neither load a shared base image nor delete shared input layouts.

#### Scenario: Content-preserving derivative

- **WHEN** a valid uploaded artifact is selected
- **THEN** the case runs a captured immutable image with unchanged filesystem and runtime config except case labels, and existing case cleanup retires only its owned resources

#### Scenario: Foreign target or changed contents

- **WHEN** the case tag already exists or the derived image has undeclared config/layer differences
- **THEN** runtime use is refused and foreign/shared resources are not adopted for deletion

### Requirement: Original verification remains authoritative

All ordinary user/platform/browser acquisition sites and three shell builders SHALL use the same adapter when selected, retaining native recipes, execution shapes, budgets, diagnostics, browser packaging, model admission, cleanup and full discovery. Genuine cookie-retag/e2e build subjects SHALL remain actual builds. The operator SHALL retain final reviewed-source, archive/transfer identity and layout lifetime responsibility; the adapter SHALL NOT become a generic archive import or lifecycle supervisor.

#### Scenario: Original commands exercise uploaded content

- **WHEN** final reviewed-head images are built locally, transferred and selected
- **THEN** original full Docker/deployment/stability suites exercise the derived images with unchanged runtime oracles, followed by independent owned retirement/protected-host evidence and same-head CI

#### Scenario: Native and authorization boundaries

- **WHEN** native mode or model missing-key checks execute
- **THEN** existing native behavior and pre-acquisition model refusal remain, with no new provider grant or retries
