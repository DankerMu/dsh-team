## ADDED Requirements

### Requirement: Documentation-only diffs are classified exactly

The docker-evidence CI job MUST exempt a diff from trusted Docker evidence only when the diff is non-empty and every changed path (`git diff --no-renames --name-only`, for both the PR range and the main-push range) is either Markdown outside `plugins/` and `images/`, or exactly the OpenSpec change metadata file `.openspec.yaml` directly inside `openspec/changes/<change>/` or `openspec/changes/archive/YYYY-MM-DD-<change>/`, with the date and name grammar taken from `constraints.yaml` `managed_archive_pattern`. Any other path, any path under `plugins/` or `images/`, an empty diff, an unreadable range and an unreadable classifier configuration MUST keep the evidence requirement or fail the job; none of them may produce a documentation-only verdict.

#### Scenario: OpenSpec archive with change metadata is documentation-only

- **WHEN** a diff contains only Markdown under `openspec/` plus `openspec/changes/<change>/.openspec.yaml` deleted and `openspec/changes/archive/<date>-<change>/.openspec.yaml` added
- **THEN** the job reports a documentation-only change and succeeds without reading Docker evidence

#### Scenario: Non-metadata YAML still requires evidence

- **WHEN** a diff contains `openspec/config.yaml`, a nested or misnamed `.openspec.yaml`, or any path under `plugins/` or `images/`
- **THEN** the classifier names the offending path and the job requires trusted Docker evidence

#### Scenario: Classifier failure never exempts

- **WHEN** the classifier cannot read `managed_archive_pattern` or receives an empty path list
- **THEN** no documentation-only verdict is produced and the job requires evidence or fails
