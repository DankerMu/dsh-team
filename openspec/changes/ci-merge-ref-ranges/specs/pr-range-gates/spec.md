## MODIFIED Requirements

### Requirement: The PR diff-size gate counts exactly the PR's own lines

The required diff-size check SHALL count every added or changed line, blank lines and lines whose content starts with `+` or `-` included, between the merge-base of the merge ref's base tip and the pull request head, excluding deleted files, whitespace-only changes, `pnpm-lock.yaml` and `schemas/openapi.json`, and binary files. Type changes (for example a symlink replaced by a regular file) SHALL be counted like modifications. Git attributes SHALL be read from the base tip, never from attributes the pull request adds or changes. It SHALL NOT count commits the base gained after the pull request branched, regardless of the event payload's base SHA. When the count cannot be computed (an unresolvable ref, a head that is not a two-parent merge, a git that cannot read attributes from the base, or a failing `git diff`), the check SHALL fail with a fixed reason and SHALL never report zero. The `diff-limit-exempt` label still skips it.

#### Scenario: Stale payload base and dash-leading lines

- **WHEN** the base advanced after the pull request branched and the pull request adds lines starting with `+` or `-` and blank lines
- **THEN** the check reports exactly the pull request's own changed lines

#### Scenario: Uncountable range

- **WHEN** the merge ref has no second parent or `git diff` fails
- **THEN** the check fails with a fixed reason instead of counting zero

#### Scenario: The pull request marks every file binary

- **WHEN** the pull request adds a `.gitattributes` containing `* -diff` and a 300-line file
- **THEN** the check counts the 300 lines and the `.gitattributes` line

#### Scenario: A symlink becomes a regular file

- **WHEN** the pull request replaces a symlink with a 500-line regular file
- **THEN** the check counts the 500 added lines and the removed link line

## ADDED Requirements

### Requirement: The lockfile pairing check reads the PR's own changed paths

The lockfile-manifest consistency check SHALL compare the paths changed between the merge-base of the merge ref's base tip and the pull request head, never a range starting at the event payload's base SHA. A pull request that changes `pnpm-lock.yaml` without any `package.json` SHALL fail it unless the `lockfile-refresh` label is set, even when the base changed a `package.json` after the payload's base SHA. When the merge ref is not a two-parent merge, the check SHALL fail.

#### Scenario: Stale payload base and a lockfile-only pull request

- **WHEN** the base changed a `package.json` after the payload's base SHA and the pull request changes only `pnpm-lock.yaml`
- **THEN** the check fails with the lockfile-only error

#### Scenario: Lockfile and manifest together

- **WHEN** the pull request changes `pnpm-lock.yaml` and a `package.json`
- **THEN** the check passes

#### Scenario: Not a merge ref

- **WHEN** `HEAD` has no second parent
- **THEN** the check fails with a fixed reason
