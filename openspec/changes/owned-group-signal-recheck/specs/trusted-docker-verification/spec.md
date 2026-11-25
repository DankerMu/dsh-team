## ADDED Requirements

### Requirement: Owner group signal rechecks the command's exit immediately before signalling

When trusted custody signals its captured command group, it SHALL re-read the command's exit and signal state synchronously after the last identity check and immediately before sending the signal, with no asynchronous step in between. If the command has already ended, it SHALL NOT signal the group and SHALL report that no signal was sent.

#### Scenario: Command ends during the final identity check

- **WHEN** the captured command exits while the owner's final identity check is still pending
- **THEN** the owner sends no group signal and reports that it did not signal
