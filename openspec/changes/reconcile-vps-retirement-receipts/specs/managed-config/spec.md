## ADDED Requirements

### Requirement: Trusted retirement distinguishes observation failure from canonical host cleanup

The trusted operator SHALL distinguish transport/observation failure, host cleanup status and model execution status. Retirement MAY obtain one bounded canonical receipt for the same currently owned invocation when the initial observer did not produce a valid receipt. It SHALL NOT turn missing, malformed, unreachable, foreign or cleanup-failed evidence into cleanup success, retry model execution, extend existing deadlines or widen resource authority. The historical cause of an unclassified observation failure SHALL remain unknown.

#### Scenario: Failed observer precedes successful finalization

- **WHEN** the initial observer fails and the same owned invocation subsequently has a valid canonical receipt confirming completed host cleanup
- **THEN** recovery reads that canonical receipt through the bounded read-only path rather than reusing synthetic observer failure as the host result
- **AND** the failed observation remains independently recorded, while whole-invocation cleanup still requires all existing credential and ownership conditions

#### Scenario: Execution failure is independent of host cleanup

- **WHEN** a valid receipt confirms host cleanup but records nonzero execution exit
- **THEN** cleanup may complete and the exact owned admission lock may retire without converting failed model execution into success
- **AND** a valid receipt reporting cleanup failure still blocks retirement even if execution succeeded

#### Scenario: Observer process exit precedes complete stdout

- **WHEN** an observer exits while its bounded stdout still has pending receipt bytes
- **THEN** parsing waits for stream settlement and never treats a partial buffer at process exit as the complete receipt
- **AND** transport, output-bound, stream and parse failures retain explicit safe observation facts without storing raw output

#### Scenario: Canonical evidence remains unknown or invalid

- **WHEN** the bounded canonical read fails, is missing, exceeds its limit or has an invalid cleanup/exit/failure envelope
- **THEN** cleanup remains unconfirmed and the invocation's admission lock is retained
- **AND** there is no loop of receipt retries or new execution admission

#### Scenario: Current authority does not match

- **WHEN** current invocation ownership is foreign or cannot be confirmed, or the active lock belongs to another invocation
- **THEN** retirement does not remove that foreign or unconfirmed lock or derive cleanup authority from an old observer result

#### Scenario: Diagnostic custody

- **WHEN** observation and recovery receipts are retained after success or failure
- **THEN** only bounded classifications, process status/signal, elapsed time, byte counts, configured bounds and validated cleanup projections are persisted
- **AND** credentials, authorization contents, arbitrary error text and raw process output never enter diagnostics
