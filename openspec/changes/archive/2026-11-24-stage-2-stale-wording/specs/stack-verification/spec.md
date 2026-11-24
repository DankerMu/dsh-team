## ADDED Requirements

### Requirement: A stack session failure folds each cause once

When an Office stack session failure wraps a stack workbench failure, the cause-chain part of its message SHALL contain each cause's message exactly once.

#### Scenario: A forgotten-lane failure wraps a workbench failure

- **WHEN** an Office forgotten lane failure is built from a workbench failure whose cause is a locator timeout
- **AND** neither the scene nor the evidence lists contain that timeout text
- **THEN** the timeout message appears exactly once in the resulting message
