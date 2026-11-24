## ADDED Requirements

### Requirement: Custody held cases are budgeted from measurement and their preconditions hold by construction

The trusted-docker custody held cases SHALL share one case budget constant for both their fixture deadline and their runner bound. That constant SHALL be derived from the measured maximum, under load, of each held case's whole callback, plus a stated margin; cleanup is measured against the reserve. The terminal-wait case SHALL establish its precondition explicitly: less than the terminal wait's own cap remains before the wait starts. The slow-owner case SHALL read the invocation's files only after a bounded wait observes them.

#### Scenario: Setup is slow under load

- **WHEN** the integration project runs at a 1-minute load within the measured range
- **THEN** each held case's step under test and the steps after it complete inside the case budget

#### Scenario: Setup is fast in the terminal-wait case

- **WHEN** the terminal-wait case reaches leaf readiness with at least the terminal wait's cap remaining
- **THEN** it waits until less than the cap remains, and the case deadline, not the cap, ends the terminal wait

#### Scenario: The killed start has not yet written its files

- **WHEN** the slow-owner case's start is killed before the start CLI has created the invocation directory and `launch.json`
- **THEN** the case waits for them inside its launch window and reads them afterwards, or fails with `Slow start published no launch`
