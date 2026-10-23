## ADDED Requirements

### Requirement: Restricted model worker retains safe preparation phase evidence

The restricted real-model worker SHALL publish, before each of its admission, checkout, install, build and driver phases begins, a private atomic receipt naming that phase, and SHALL record when the phase ends whether it completed or failed together with only closed-set facts: exit status, signal and a failure category. The worker's execution result SHALL carry the last phase and category without changing its existing exit status semantics. These receipts SHALL NOT contain raw command output, arguments, environment, error text, credentials or proxy values, and SHALL NOT change admission, deadlines, cleanup, owner receipt parsing or provider authorization.

#### Scenario: Preparation command fails

- **WHEN** a checkout, install or build command exits nonzero, is signalled, times out, exceeds its output bound or fails to spawn
- **THEN** the phase receipt names that phase with state failed and the matching closed-set category, exit status and signal
- **AND** the execution result keeps exit status 1 and names the same phase and category

#### Scenario: Phase is interrupted after entry

- **WHEN** the worker is terminated while a phase is running
- **THEN** the retained phase receipt still names the entered phase, without claiming completion or failure category

#### Scenario: Diagnostic output never leaks

- **WHEN** a preparation command's arguments, stdout, stderr or thrown error contain a marker value
- **THEN** no phase, execution or final receipt contains that marker

#### Scenario: Existing receipt consumers remain compatible

- **WHEN** finalization and the trusted owner read execution and final receipts with or without phase facts
- **THEN** a valid receipt yields the same host cleanup and execution status as before, the final receipt keeps exactly its existing fields, and execution failure is never rewritten by cleanup success

#### Scenario: Malformed execution result fails closed

- **WHEN** finalization finds an execution result that is missing, not a private regular file, oversized, malformed or has an exit status outside 0..255
- **THEN** the final receipt records exit status 1 instead of throwing or copying the invalid value, and host cleanup status is still reported independently
