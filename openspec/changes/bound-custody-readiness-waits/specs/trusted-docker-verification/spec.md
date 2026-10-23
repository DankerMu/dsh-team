## ADDED Requirements

### Requirement: Custody regressions wait for readiness through a bounded fail-fast signal

Trusted custody integration regressions SHALL wait for owned process readiness only through an explicit, measurement-derived deadline that fits within each test's existing bound, and SHALL accept only a complete readiness record published atomically. While waiting they SHALL fail immediately, with sanitized terminal evidence, once the invocation has published its terminal result or its owner is absent, instead of waiting out the deadline.

#### Scenario: Readiness arrives late under load

- **WHEN** a leaf publishes its readiness record later than one second but within the explicit deadline
- **THEN** the regression proceeds to its custody assertions unchanged

#### Scenario: The invocation ends before readiness

- **WHEN** the owner publishes a terminal result or exits before readiness is observed
- **THEN** the wait fails immediately with sanitized terminal evidence rather than a generic timeout
