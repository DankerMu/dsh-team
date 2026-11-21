## ADDED Requirements

### Requirement: A rejected observer reservation leaves submission pending markers unchanged

When `reserveVerificationDockerObserver` rejects before publishing a reservation, for example because the current predecessor generation's completion cannot be confirmed, it SHALL NOT write, remove or settle any submission pending marker, append to the submission journal, or change the current manifest.

#### Scenario: Reservation rejected while the predecessor is still live

- **WHEN** a predecessor generation with an unsettled participant and outstanding request markers is still running, and a second reservation for the same authority is rejected
- **THEN** the rejected reservation writes, removes or settles no pending marker and leaves the current manifest unchanged
