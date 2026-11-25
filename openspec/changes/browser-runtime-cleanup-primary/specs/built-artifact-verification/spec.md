## ADDED Requirements

### Requirement: Browser runtime wrapper case cleanup keeps the case failure

The browser runtime wrapper integration cases SHALL NOT let their cleanup replace a case's failure. Each cleanup step, stopping the held stand-in and removing the case tree, SHALL run even if the other fails. A cleanup failure SHALL be appended to the case failure as a labelled residual; when the case passed, the residual alone SHALL fail it.

#### Scenario: Tree removal fails after a case failure

- **WHEN** a wrapper case fails and removing its tree also fails
- **THEN** the reported error is the case failure, followed by a cleanup residual naming the removal failure
