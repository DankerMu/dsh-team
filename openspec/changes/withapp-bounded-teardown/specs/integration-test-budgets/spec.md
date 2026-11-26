## MODIFIED Requirements

### Requirement: Remaining tail sites bound each step from the case budget and name their stalls

The RAGFlow proxy close-abort case, the canonical dev-stop lifecycle case's user registration and instance start, and the chrome-start near-deadline case SHALL derive each inner wait from the remaining case budget measured from when that step starts. A stalled step SHALL fail below the case budget with a message naming its phase. A near deadline that a case injects into code under test SHALL be measured from where the wait it cuts begins, so slow preparation under load, including preparation inside the code under test, cannot turn the row red.

#### Scenario: A step stalls under its case budget

- **WHEN** the upstream never receives or never closes, the application close outlasts its step bound but still finishes within the case budget, the start route's engine call is held, or the registration never answers
- **THEN** the case fails below its budget with a message naming that step, not with the runner's timeout

#### Scenario: Slow preparation before a near deadline

- **WHEN** the chrome-start preparation takes longer than the near-deadline offset
- **THEN** the acknowledgement wait still starts with the full offset, and the row's attribution is unchanged

#### Scenario: The application close never finishes

- **WHEN** an `onClose` hook in the close-abort case never settles
- **THEN** the case fails below its budget with a message starting with the close-abort application close step, the bounded teardown close reported with it, and no runner timeout

## ADDED Requirements

### Requirement: The shared application teardown close is bounded and never replaces the case's failure

The integration helper that builds the platform application for a case SHALL bound its teardown close by a deadline the case passes, or by a measured default when it passes none. When the close does not settle in time, the case SHALL fail with a message naming the teardown close. The teardown deadline SHALL be separate from the deadline of the case's own steps, so a stalled step never prevents a healthy application from closing. When the case had already failed, that failure SHALL stay first and the teardown failure SHALL be reported with it; a healthy teardown SHALL rethrow the case's failure unchanged.

#### Scenario: The case succeeds but its close hangs

- **WHEN** a case's body succeeds and an `onClose` hook never settles
- **THEN** the case fails with the teardown close named, before its runner timeout

#### Scenario: The case fails and its close hangs

- **WHEN** a case's body fails and an `onClose` hook never settles
- **THEN** the reported failure starts with the body's failure and also names the teardown close

#### Scenario: The case fails and its close is healthy

- **WHEN** a case's body fails and the teardown close settles
- **THEN** the body's failure is rethrown unchanged
