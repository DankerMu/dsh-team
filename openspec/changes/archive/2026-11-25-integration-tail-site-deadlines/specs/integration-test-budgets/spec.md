## ADDED Requirements

### Requirement: Remaining tail sites bound each step from the case budget and name their stalls

The RAGFlow proxy close-abort case, the canonical dev-stop lifecycle case's user registration and instance start, and the chrome-start near-deadline case SHALL derive each inner wait from the remaining case budget measured from when that step starts. A stalled step SHALL fail below the case budget with a message naming its phase. A near deadline that a case injects into code under test SHALL be measured from where the wait it cuts begins, so slow preparation under load, including preparation inside the code under test, cannot turn the row red.

#### Scenario: A step stalls under its case budget

- **WHEN** the upstream never receives or never closes, the application close outlasts its step bound but still finishes within the case budget, the start route's engine call is held, or the registration never answers
- **THEN** the case fails below its budget with a message naming that step, not with the runner's timeout

#### Scenario: Slow preparation before a near deadline

- **WHEN** the chrome-start preparation takes longer than the near-deadline offset
- **THEN** the acknowledgement wait still starts with the full offset, and the row's attribution is unchanged
