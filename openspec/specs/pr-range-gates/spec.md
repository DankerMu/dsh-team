# pr-range-gates Specification

## Purpose

CI checks a pull request's whole commit range, not only the local hooks. Every commit message in the PR is held to the conventional-commit rules, and every added path to the naming and scratch-directory rules, through `pnpm lint:pr <base> <head>`.

## Requirements

### Requirement: Commit messages and new paths are gated over the PR range in CI

The required CI check SHALL fail a pull request when either of these holds:

- one of its own commits violates the conventional-commit configuration;
- one of its added or renamed paths violates the naming and scratchpad rules. The managed archive exemption still applies.

A path counts as added when any commit in the range adds or renames it, including a merge commit, even if a later commit in the range deletes it again; the check SHALL take the union of the net range diff and every commit's own added or renamed paths. The check SHALL consider only the pull request's own commits and paths. A base equal to the head SHALL be an unreadable range. A message SHALL be exempt from commit linting only when its subject is a Dependabot version-update subject (`build(deps): Bump …` or `build(deps-dev): Bump …`) and it carries Dependabot's signed-off trailer. It SHALL fail when the range cannot be resolved, and SHALL never treat an unresolved range as empty. It SHALL NOT fail a push to the main branch because of earlier history.

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

#### Scenario: A forbidden path added and removed inside the range

- **WHEN** one commit in the range adds `tmp/x.md` and a later commit in the same range deletes it
- **THEN** the required check fails

#### Scenario: A forbidden path added only by a merge commit

- **WHEN** a merge commit inside the range is the only commit that adds `wip/x.md`
- **THEN** the required check fails

#### Scenario: A Dependabot version-update commit

- **WHEN** a commit has the subject `build(deps): Bump x from 1 to 2` and the trailer `Signed-off-by: dependabot[bot] <support@github.com>`
- **THEN** the commit-message check accepts it
- **AND** the same subject without that trailer is still rejected

#### Scenario: Equal base and head

- **WHEN** the range check receives the same commit as base and head
- **THEN** it fails with the fixed unreadable-range reason

### Requirement: The PR diff-size gate counts exactly the PR's own lines

The required diff-size check SHALL count every added or changed line, blank lines and lines whose content starts with `+` or `-` included, between the merge-base of the merge ref's base tip and the pull request head, excluding deleted files, whitespace-only changes, `pnpm-lock.yaml` and `schemas/openapi.json`, and binary files. Type changes (for example a symlink replaced by a regular file) SHALL be counted like modifications. Git attributes SHALL be read from the base tip, never from attributes the pull request adds or changes. It SHALL NOT count commits the base gained after the pull request branched, regardless of the event payload's base SHA. When the count cannot be computed (an unresolvable ref, a head that is not a two-parent merge, parents with more than one merge base, a git that cannot read attributes from the base, or a failing `git diff`), the check SHALL fail with a fixed reason and SHALL never report zero. The `diff-limit-exempt` label still skips it.

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

### Requirement: The lockfile pairing check reads the PR's own changed paths

The lockfile-manifest consistency check SHALL compare the paths changed between the merge-base of the merge ref's base tip and the pull request head, never a range starting at the event payload's base SHA. A pull request that changes `pnpm-lock.yaml` without any `package.json` SHALL fail it unless the `lockfile-refresh` label is set, even when the base changed a `package.json` after the payload's base SHA. When the merge ref is not a two-parent merge, or its parents have more than one merge base, the check SHALL fail.

#### Scenario: Stale payload base and a lockfile-only pull request

- **WHEN** the base changed a `package.json` after the payload's base SHA and the pull request changes only `pnpm-lock.yaml`
- **THEN** the check fails with the lockfile-only error

#### Scenario: Lockfile and manifest together

- **WHEN** the pull request changes `pnpm-lock.yaml` and a `package.json`
- **THEN** the check passes

#### Scenario: Not a merge ref

- **WHEN** `HEAD` has no second parent
- **THEN** the check fails with a fixed reason

#### Scenario: Several merge bases

- **WHEN** the merge ref's parents have two merge bases and the pull request changes only `pnpm-lock.yaml` while a `package.json` change is reachable from one base
- **THEN** the check fails with a fixed reason
