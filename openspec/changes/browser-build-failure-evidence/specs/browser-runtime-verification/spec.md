## ADDED Requirements

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
