## ADDED Requirements

### Requirement: Development watch cleanup keeps the case failure and labels its residual

The development watch integration cleanup SHALL NOT replace a case's failure with an error of its own. It SHALL append each cleanup failure, including failing to remove the fixture tree, as a labelled residual. Its stop residual SHALL say whether the group was retired by SIGKILL, was still present after SIGKILL, or whether the SIGKILL call failed.

#### Scenario: Fixture tree removal fails after a case failure

- **WHEN** a case fails and removing its fixture tree also fails
- **THEN** the reported error is the case failure followed by a cleanup residual naming the removal failure

#### Scenario: A group that ignores SIGTERM is retired by SIGKILL

- **WHEN** the watcher group outlives the SIGTERM wait and SIGKILL then retires it
- **THEN** the residual labels the SIGTERM timeout and states that SIGKILL retired the group
