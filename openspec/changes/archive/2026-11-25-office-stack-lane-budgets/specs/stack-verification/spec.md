## ADDED Requirements

### Requirement: The stack case timeout covers every serial opening wait

The local full-stack ledger SHALL count every execution of the Office editor opening and typing helpers at the bounds of their serial waits, including each caller's `loaded` hook, multiplied by its execution count. The case timeout SHALL include that sum. A stalled opening wait SHALL therefore fail with its own label before the case timeout, and the RAGFlow restore SHALL still run. Other lane waits stay in the ledger's margin.

#### Scenario: Every opening wait runs to its bound

- **WHEN** every serial wait of every Office editor opening and typing execution runs until just under its bound
- **THEN** the case timeout has not yet fired

### Requirement: The typing rewrite case holds a quiet window

After its notices clear, the Office rewrite lane's typing case SHALL first read its notice facts, including the notice times and the latch since typing began, then re-arm the notice latch and observe a fixed quiet window, as the clean and unsaved cases do. A notice appearing in that window SHALL fail the case.

#### Scenario: A notice returns after the clear

- **WHEN** a notice appears within the quiet window after the typing case's notices cleared
- **THEN** the case's facts differ from the expectation and the case fails

### Requirement: The forgotten-store diagnostic tolerates a vanishing entry

The forgotten-store shape diagnostic SHALL treat an entry that disappears between listing and inspection as absent, report the remaining entries, and SHALL NOT fail because of that disappearance. Other inspection errors SHALL still fail it.

#### Scenario: An entry vanishes mid-scan

- **WHEN** a store entry is deleted after the store is listed and before it is inspected
- **THEN** the diagnostic succeeds and reports the other entries
