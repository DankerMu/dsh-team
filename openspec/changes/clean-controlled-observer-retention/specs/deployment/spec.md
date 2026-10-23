## ADDED Requirements

### Requirement: Controlled deployment failure regressions retire their own observer root

A deployment verification test whose scenario failure is a deliberately injected and asserted expectation SHALL remove the private observation root it owns after all of its assertions pass, using the observation it captured and the existing directory identity fence. Observation roots of genuine failures, failed regressions and outer custody-owned roots SHALL be retained as before. Removal SHALL NOT discover, prefix-match or globally clean `/tmp`, and a removal failure SHALL fail the test.

#### Scenario: Controlled failure regression passes

- **WHEN** a deployment regression injects its expected failure and all of its assertions pass
- **THEN** its captured, retired, identity-verified owned observer root is removed and no new `/tmp/dsh-team-observer-*` directory remains after the run

#### Scenario: Regression or retirement fails

- **WHEN** the regression's assertions fail, the observation was not retired, or the root identity changed
- **THEN** the root is retained and the test reports failure
