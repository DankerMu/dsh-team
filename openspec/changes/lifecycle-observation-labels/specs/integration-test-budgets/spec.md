## ADDED Requirements

### Requirement: The instance lifecycle case's observations name their phase and its default-bound aggregate waits have measured bounds

Every HTTP peer observation in the instance lifecycle integration file SHALL pass a unique phase label, so a stalled observation reports its site.

In the canonical dev-stop case, each default-bound scenario observation that waits for a whole child process or a run of background requests SHALL carry a comment stating its measured basis: load band, runs, maximum and multiple. That covers the readiness after the start POST and the restarted `dev:bg` exit. Such an observation SHALL get a named bound when the default leaves less than ten times its measured maximum. The case's budget ledger SHALL account for those bounds, and those bounds plus the measured setup SHALL stay below the case budget.

#### Scenario: A scenario-phase stall is attributable

- **WHEN** an observation in the lifecycle case's scenario phase or in its dev-lifecycle helper's setup never settles
- **THEN** the case fails with `HTTP peer observation did not settle: <label>`, naming that observation

#### Scenario: A cleanup-phase stall is attributable

- **WHEN** the commands-settlement or `dev:stop` observation in the dev-lifecycle cleanup never settles
- **THEN** the case's cleanup failure marks that step `failed` and carries the labelled observation error in its cause
