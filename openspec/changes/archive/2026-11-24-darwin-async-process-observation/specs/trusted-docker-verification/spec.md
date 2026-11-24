## ADDED Requirements

### Requirement: Process birth observation does not block the owner

On Darwin, the trusted-verification process birth observation SHALL run without blocking the observing process's event loop, and SHALL keep the native query's bounded timeout, its forced kill on timeout or oversized output, and its existing outcomes and fail-closed rule.

#### Scenario: A hung native observation does not freeze the owner

- **WHEN** the native birth query does not answer
- **THEN** a short timer in the same process fires before the observation settles
- **AND** the observation rejects as unavailable no earlier than its bound, and the query process has been killed

#### Scenario: A missing interpreter is not absence

- **WHEN** the native query cannot be started
- **THEN** the observation rejects as unavailable without an absence code, and a liveness check does not report the process gone
