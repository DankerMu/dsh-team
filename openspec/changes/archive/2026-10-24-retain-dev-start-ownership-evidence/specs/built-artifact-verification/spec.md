## ADDED Requirements

### Requirement: Background start ownership verification retains safe timeout evidence

The background development lifecycle integration SHALL keep its initial source-main ownership predicate, 5000ms bound and leading timeout text, and on timeout SHALL attach only closed-set evidence. That evidence SHALL name the start command's state, exit code, signal and relative close time; the first-observed relative times of the private lifecycle lock, built web entry, main log and a valid PID; and the final pidfile state. Scenario cleanup SHALL record each step's outcome independently and SHALL NOT replace the first scenario failure. No raw output, environment, credentials or log content SHALL enter the evidence.

#### Scenario: Startup held before PID publication

- **WHEN** the Engine preflight is held beyond the ownership bound
- **THEN** the failure keeps the original timeout text and reports lock and web build observed, no main log or PID, the command still running and the pidfile missing
- **AND** cleanup independently confirms command settlement, no surviving main, Engine closure and private root removal

#### Scenario: Startup exits before PID publication

- **WHEN** the Engine preflight fails
- **THEN** the evidence reports the command closed with its exit code and no PID observed

#### Scenario: Unconfirmed retirement retains the private root

- **WHEN** command settlement or main retirement is not confirmed during cleanup
- **THEN** the private root with its pidfile, lock and log is retained and the root step is reported failed, while the first scenario failure stays primary

#### Scenario: Evidence stays secret-free

- **WHEN** evidence is produced
- **THEN** it contains no fixture credential, socket path, environment value or log content
