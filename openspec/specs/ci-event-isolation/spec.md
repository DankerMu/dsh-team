# CI event isolation Specification

## Purpose

Define CI scheduling boundaries that preserve independent same-head pull-request event checks and truthful required-status aggregation without changing label authority or main-push execution policy.

## Requirements

### Requirement: Independent pull-request invocations retain their required checks

CI MUST execute opened, synchronize, reopened, labeled and unlabeled pull-request deliveries without automatically canceling or replacing another same-head invocation's pending or running required checks. Repeated deliveries of the same action MUST also remain independent. Main pushes MUST retain their existing shared-ref grouping and no-running-cancellation policy.

#### Scenario: Open and label events share a candidate

- **WHEN** a PR is opened with an exemption label and that label is removed while CI is active on the same head
- **THEN** the opened, labeled and unlabeled invocations settle without sibling-induced cancellation
- **AND** each label-sensitive gate evaluates that event's label snapshot and the final unexempted invocation runs the normal gate

#### Scenario: Repeated label deliveries cannot evict a pending sibling

- **WHEN** distinct workflow invocations for the same PR/head have the same labeled action
- **THEN** their concurrency groups do not collide even when one is still pending

#### Scenario: Main execution policy is preserved

- **WHEN** two main push invocations are evaluated
- **THEN** they retain the existing shared-ref group and running cancellation remains disabled

### Requirement: Scheduling regressions fail the repository gate

The repository MUST evaluate the delivered CI concurrency configuration with the GitHub expression semantics and reject same-head PR group collisions, malformed policies and main-policy regressions. Guardrail verification MUST accept the actual candidate and reject plausible wrong policies without changing production code or gate thresholds.

#### Scenario: Old or action-only grouping is rejected

- **WHEN** the workflow uses the original ref-only group, shared ref grouping with cancellation disabled, or an action-only group that collides for repeated label deliveries
- **THEN** the policy gate rejects the unsafe scheduling policy rather than silently allowing cancellation or pending replacement

#### Scenario: Genuine required failures remain failures

- **WHEN** any required dependency fails, is cancelled or is skipped
- **THEN** the existing aggregate rejects it and no branch-protection requirement, label gate or approval policy is bypassed
