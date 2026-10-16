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
