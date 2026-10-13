# Canonicality archive policy

## Purpose

Allow the repository's standard OpenSpec completion records without permitting unrelated scratchpad archives or weakening existing file-name restrictions.

## ADDED Requirements

### Requirement: Standard managed archive component is accepted

The naming gate MUST allow the managed archive component in root-relative `openspec/changes/archive/YYYY-MM-DD-<kebab-change>/<file>` paths in both path-argument and staged-index modes. The exception MUST be explicitly configured in the existing canonical policy source and MUST NOT apply to dot-segment aliases, missing descendants or other archive layouts.

#### Scenario: Normal OpenSpec completion artifacts

- **WHEN** proposal, tasks, metadata or nested capability specification files are checked beneath a standard dated OpenSpec change archive
- **THEN** the managed archive component does not cause rejection in either entrypoint

#### Scenario: Similar but noncanonical archive location

- **WHEN** an archive is outside the exact root-relative standard layout or includes a dot-segment alias
- **THEN** the existing scratchpad rejection remains effective

### Requirement: An archive exception never bypasses other restrictions

The naming gate MUST continue to reject forbidden suffixes in the original full path, other scratchpad components below an otherwise valid archive, and unrelated invalid staged files. Both entrypoints MUST share the same path-policy decision while preserving their existing diagnostics and exit codes. An absent exception configuration MUST retain existing strict rejection.

#### Scenario: Forbidden artifact inside an otherwise eligible archive

- **WHEN** a standard archive contains a nested scratchpad directory or forbidden file suffix
- **THEN** both entrypoints reject the path for the applicable original restriction

#### Scenario: Valid archive mixed with an unrelated violation

- **WHEN** the staged index contains both an eligible OpenSpec artifact and an unrelated forbidden path
- **THEN** the overall staged check fails and identifies the invalid path

#### Scenario: No exception policy configured

- **WHEN** the managed archive exception setting is absent
- **THEN** archive paths retain the previous scratchpad rejection behavior
