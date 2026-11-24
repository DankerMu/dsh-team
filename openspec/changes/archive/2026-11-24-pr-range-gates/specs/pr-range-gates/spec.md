## ADDED Requirements

### Requirement: Commit messages and new paths are gated over the PR range in CI

The required CI check SHALL fail a pull request when either of these holds:

- one of its own commits violates the conventional-commit configuration;
- one of its added or renamed paths violates the naming and scratchpad rules. The managed archive exemption still applies.

The check SHALL consider only the pull request's own commits and paths. It SHALL fail when the range cannot be resolved, and SHALL never treat an unresolved range as empty. It SHALL NOT fail a push to the main branch because of earlier history.

#### Scenario: A PR commit has an overlong subject

- **WHEN** a pull request contains a commit whose subject exceeds the configured maximum
- **THEN** the required check fails

#### Scenario: A PR adds a forbidden path

- **WHEN** a pull request adds a file with a forbidden suffix, or a file under a scratchpad directory outside the managed archive
- **THEN** the required check fails

#### Scenario: A PR adds a managed archive file

- **WHEN** a pull request adds `openspec/changes/archive/YYYY-MM-DD-<change>/<file>`
- **THEN** the range check passes for that path

#### Scenario: Base history is not the PR's

- **WHEN** a pull request's base history contains non-conforming commits or forbidden paths
- **AND** the pull request's own commits and added paths conform
- **THEN** the required check passes

#### Scenario: Unreadable range

- **WHEN** the base or head cannot be resolved, or the two share no merge base
- **THEN** the check fails with a fixed reason
- **AND** the range is never treated as empty

#### Scenario: Main history is not re-checked

- **WHEN** a commit is pushed to the main branch whose history contains earlier non-conforming commit messages
- **THEN** the range check does not run
- **AND** it does not fail the build
