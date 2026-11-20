## ADDED Requirements

### Requirement: Docker verification cases do not tolerate unanswered mutations

Every Docker verification case under `platform/test/` and every verification script under `scripts/` SHALL treat a shared-Engine mutation that fails as either an explicitly expected outcome or a test failure. An expected nonzero CLI exit SHALL be declared as that call's exact `acceptedStatus` and SHALL be accompanied by an independent check of the outcome the status claims. Any other CLI nonzero exit, signal, spawn error or lost response, and any Engine HTTP error outside the qualified rejection matrix, SHALL fail the case rather than be caught and continued, and SHALL NOT rely on custody cleanup to absorb it. The qualified rejection matrix and the `unconfirmed` cleanup judgement SHALL NOT be widened to make a tolerated failure settle.

#### Scenario: An expected nonzero exit is declared and proven

- **WHEN** a case intentionally runs a Docker CLI mutation that exits with a known nonzero status
- **THEN** the call declares exactly that `acceptedStatus`, its submission settles only on that exact normal exit, and the case independently verifies the resource state the status implies
- **AND** a different status, a signal or an error for the same call leaves the submission unresolved and fails the case

#### Scenario: An unexpected mutation failure surfaces in the case

- **WHEN** a mutating Docker CLI call or a tracked Engine HTTP mutation fails outside its declared status or the qualified rejection matrix
- **THEN** the issuing case fails with that error instead of catching it and continuing
- **AND** custody cleanup remains `unconfirmed` for the unresolved submission rather than being reclassified

#### Scenario: A tolerating call site is converted test-first

- **WHEN** an audited call site that previously caught a mutating failure without rethrowing is changed
- **THEN** a regression for that call site fails against the tolerant code and passes after the change, and exact-head full `pnpm test:docker` on the trusted host reports cleanup `confirmed`

### Requirement: Unconfirmed submission settlement reports a bounded call projection

When the cleanup assessment is unconfirmed because one or more submissions remain unsettled or keep a pending marker, the private terminal evidence SHALL include a bounded projection of those unresolved submissions: for each distinct closed-set `call` label recorded on their `submitted` rows, the label and its count, with rows that carry no label counted under a fixed `unlabelled` entry. The projection SHALL contain no submission identifiers, arguments, resource names, paths, environment values or credentials, SHALL be absent when cleanup is confirmed, and SHALL NOT change the settlement or cleanup verdict. Attribution of a root cause SHALL remain UNKNOWN unless the projection or other retained evidence identifies the call site.

#### Scenario: An orphaned labelled submission is attributable from the terminal

- **WHEN** a test-process Docker CLI mutation reserves its submission and never publishes completion, while every test passes and owned resources are absent
- **THEN** the terminal reports cleanup `unconfirmed` with a projection naming that row's transport, fixed-vocabulary operation and caller basename with count one
- **AND** the operator can locate the call site without reading the private journal

#### Scenario: An unlabelled orphan is counted without guessing

- **WHEN** the unsettled submission was reserved without a call label
- **THEN** the projection reports it under `unlabelled` and no operation or caller is inferred

#### Scenario: Confirmed cleanup carries no projection

- **WHEN** every submission settled and cleanup is confirmed
- **THEN** the terminal cleanup evidence has no unresolved-submission projection and terminal parsing accepts it as before
