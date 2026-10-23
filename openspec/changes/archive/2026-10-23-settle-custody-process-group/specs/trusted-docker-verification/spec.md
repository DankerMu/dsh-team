## ADDED Requirements

### Requirement: Command settlement waits a bounded window for genuine group absence

After the owned command's actual close, trusted custody SHALL observe its process group within one bounded observation window and SHALL record the command settled only on a genuine process-group absence (`ESRCH`). A group still present when the window expires SHALL remain unsettled. An EPERM observation SHALL never count as absence and SHALL be observed again within the window; if the final observation at expiry is EPERM the existing identity failure SHALL be recorded. Any other non-absence error SHALL keep the existing immediate identity failure. The window SHALL NOT retry, re-run or signal the command.

#### Scenario: A group member briefly outlives the command

- **WHEN** the command closes while a member of its process group is still running or not yet reaped, and that member exits within the window
- **THEN** the published terminal records `settled: true`, cleanup is assessed normally, and a duplicate cancellation reports the terminal result with exit 0

#### Scenario: The group does not become absent

- **WHEN** a group member is still present at window expiry
- **THEN** the terminal records `settled: false` with no identity failure (status `unknown`), preserving the original command exit and signal

#### Scenario: Group observation stays denied

- **WHEN** every observation in the window is denied (EPERM)
- **THEN** the terminal records `settled: false` and the identity failure, preserving the original command exit and signal
