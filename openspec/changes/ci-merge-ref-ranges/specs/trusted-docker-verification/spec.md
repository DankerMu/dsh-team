## MODIFIED Requirements

### Requirement: Documentation-only diffs are classified exactly

The docker-evidence CI job MUST exempt a diff from trusted Docker evidence only when the diff is non-empty and every changed path (`git diff -z --no-renames --name-only`, NUL-delimited and byte-exact, for both the PR range and the main-push range) is either Markdown outside `plugins/` and `images/`, or exactly the OpenSpec change metadata file `.openspec.yaml` directly inside `openspec/changes/<change>/` or `openspec/changes/archive/YYYY-MM-DD-<change>/`, with the date and name grammar taken from `constraints.yaml` `managed_archive_pattern`. Any other path, any path under `plugins/` or `images/`, an empty diff, an unreadable range and an unreadable classifier configuration MUST keep the evidence requirement or fail the job; none of them may produce a documentation-only verdict. Path-derived text the job prints MUST NOT be interpretable as a workflow command, so a crafted file name cannot set the job's outputs. On `pull_request` events the PR range MUST be the merge ref's own range, from the merge-base of its base tip and the pull request head to that head, never a range starting at the event payload's base SHA, and a merge ref that is not a two-parent merge MUST fail the job. On `push` events the range stays `before..after`.

#### Scenario: OpenSpec archive with change metadata is documentation-only

- **WHEN** a diff contains only Markdown under `openspec/` plus `openspec/changes/<change>/.openspec.yaml` deleted and `openspec/changes/archive/<date>-<change>/.openspec.yaml` added
- **THEN** the job reports a documentation-only change and succeeds without reading Docker evidence

#### Scenario: Non-metadata YAML still requires evidence

- **WHEN** a diff contains `openspec/config.yaml`, a nested or misnamed `.openspec.yaml`, or any path under `plugins/` or `images/`
- **THEN** the classifier names the offending path and the job requires trusted Docker evidence

#### Scenario: Classifier failure never exempts

- **WHEN** the classifier cannot read `managed_archive_pattern` or receives an empty path list
- **THEN** no documentation-only verdict is produced and the job requires evidence or fails

#### Scenario: Crafted file names cannot set the verdict

- **WHEN** a diff that contains code also adds a file named `##[set-output name=docs_only;]true`
- **THEN** the job prints the offending path only inside a stop-commands block with an unpredictable token, the documentation-only output stays unset, and the job requires trusted Docker evidence

#### Scenario: A non-ASCII Markdown path

- **WHEN** a diff changes only `docs/笔记.md`
- **THEN** the job reports a documentation-only change

#### Scenario: Paths are never joined

- **WHEN** a diff changes `docs/a.md`, `platform/x.ts` and `z.md`
- **THEN** the classifier names `platform/x.ts` and the job requires trusted Docker evidence

#### Scenario: Stale payload base and a documentation-only pull request

- **WHEN** the base gained a code file after the payload's base SHA and the pull request changes only `docs/a.md`
- **THEN** the job reports a documentation-only change

#### Scenario: Pull request checkout is not a merge ref

- **WHEN** a `pull_request` run's `HEAD` has no second parent
- **THEN** the job fails and no documentation-only verdict is produced
