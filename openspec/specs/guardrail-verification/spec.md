# Guardrail verification Specification

## Purpose

Define portable execution of the repository's blocking guardrail self-test without changing the gates, their configured rejection thresholds or isolated fixture ownership.

## Requirements

### Requirement: Guardrail self-test preserves behavior across supported Bash versions

The root guardrail command MUST parse and complete under macOS Bash3.2 and Bash5. Both interpreters MUST execute the same positive and negative cases, including dynamically corpus-sized duplicate rejection, argument/staged archive-policy probes and cases after the duplicate canary. Existing thresholds and rejection reasons MUST remain authoritative. Command failure MUST remain failure; the owned fixture and any intermediate count output MUST be cleaned with no surviving fixture process or worktree.

#### Scenario: Full self-test on either supported interpreter

- **WHEN** the root guardrail command selects Bash3.2 or Bash5 with its normal tool prerequisites
- **THEN** it completes the complete self-test, reports the same pass/fail case inventory and duplicate canary size for the same corpus, and leaves no owned residue

#### Scenario: Literal heredoc contains unmatched quote characters

- **WHEN** the unchanged duplicate-sizing program contains a literal apostrophe in a comment
- **THEN** neither supported shell misparses that program as shell quotation and the computed canary still triggers the configured duplicate gate

### Requirement: Documented command membership remains exact as the inventory grows

The documented-command gate MUST accept every documented non-builtin command whose complete literal name exists in the root package script inventory, and MUST reject a missing complete name with the existing missing-command diagnostic. Adding unrelated valid scripts MUST NOT turn an existing command into a missing-command result through early consumer termination. Strict shell error handling, supported Bash versions, documented input selection and fixture isolation MUST remain intact.

#### Scenario: Large valid inventory includes the documented command

- **WHEN** unrelated valid script names enlarge the inventory beyond an ordinary pipe buffer and a documented command remains present
- **THEN** the gate accepts it without a producerSIGPIPE being misclassified as missing membership

#### Scenario: Only a prefix or near-match exists

- **WHEN** a documented complete name is absent while a longer script name shares its prefix
- **THEN** the gate exits nonzero and identifies the absent complete name

#### Scenario: Positive regression is followed by other gate cases

- **WHEN** the self-test finishes its expanded valid-inventory case
- **THEN** it restores the owned fixture before subsequent cases, preserves all existing rejection cases and leaves no fixture residue

### Requirement: Duplicate-code gate scans its configured scope

The root `duplicate-code` command MUST load the repository's `jscpd.json` explicitly and MUST scan only the formats it configures (`typescript`, `javascript`, `tsx`) under `platform/`, excluding `*.test.ts` and `*.test.tsx` files; test-support modules under `platform/test/` remain in scope. The threshold MUST continue to come from `constraints.yaml` through `scripts/constraints.mjs`. The guardrail self-test's duplicate canary MUST size its planted copies from a corpus that is never smaller than the set the gate scans, dropping exactly the files `jscpd.json` ignores, so that rejection remains proven against the gate's real corpus.

#### Scenario: Configuration is loaded

- **WHEN** `pnpm duplicate-code` runs on the clean tree
- **THEN** the configuration is read from `jscpd.json`, the format table lists only the configured formats, no `*.test.ts` or `*.test.tsx` file appears among the clones, and the command exits zero

#### Scenario: Canary still rejects after the scope change

- **WHEN** the guardrail self-test plants two identical corpus-sized functions under `platform/src/`
- **THEN** `pnpm duplicate-code` rejects with the configured threshold, the planted size is computed from the ts/js/tsx files `jscpd.json` does not ignore (a file count at least the gate's), and the result is identical under Bash 3.2 and Bash 5

### Requirement: The guardrail self-test job's time limit has a measured basis

The CI job that runs the guardrail self-test SHALL have a time limit that states its measured basis next to the value: the sampling window, the sample size, the step's median, p90 and maximum duration, and the job overhead. The limit SHALL leave room for the slowest measured run plus headroom for case growth. A job cancelled at its limit SHALL never count as success.

#### Scenario: A slow runner finishes the self-test

- **WHEN** the self-test step runs as slowly as the slowest measured run
- **THEN** the job completes at least 2 minutes before its time limit instead of being cancelled
