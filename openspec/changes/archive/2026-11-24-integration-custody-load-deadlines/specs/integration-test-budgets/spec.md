## ADDED Requirements

### Requirement: Custody held cases keep budgets with a measured basis, and the slow-owner case waits for the start's files

The trusted-docker custody held cases SHALL share one case budget constant for both their fixture deadline and their runner bound.

- That constant SHALL NOT be lower than the measured maximum under load of a held case's whole callback, plus a stated margin. Its comment SHALL state the load range, the maximum and the margin.
- Cleanup SHALL fit within the reserve.
- The terminal-wait case's fixture deadline SHALL be shorter than the terminal wait's own cap.
- The slow-owner case SHALL read the invocation's files only after a bounded wait observes them.

#### Scenario: Setup is slow under load

- **WHEN** the integration project runs at a 1-minute load within the measured range
- **THEN** each held case's step under test and the steps after it complete inside the case budget

#### Scenario: The terminal-wait case reaches leaf readiness

- **WHEN** the terminal-wait case reaches leaf readiness
- **THEN** less than the terminal wait's cap remains, because its deadline is below that cap, and the case deadline, not the cap, ends the terminal wait

#### Scenario: The killed start has not yet written its files

- **WHEN** the slow-owner case's start is killed before the start CLI has created the invocation directory and `launch.json`
- **THEN** the case waits for them inside its launch window and reads them afterwards, or fails with `Slow start published no launch`
