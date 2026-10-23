# Spec Delta

## ADDED Requirements

### Requirement: Deployment verification preserves safe setup-boundary evidence

Deployment verification SHALL identify the entered setup operation and last completed boundary using bounded closed-set phase values. A setup failure SHALL retain rejection and a fixed reason category without serializing raw exceptions, command arguments or output, credentials, proxy values, environment values or private conversation content. An observed boundary SHALL NOT be described as the underlying cause when that cause is unknown.

#### Scenario: Setup fails before audit-stop admission

- **WHEN** preparation, image construction, platform admission, health, administrator initialization or account configuration fails before the audit-stop exercise
- **THEN** evidence distinguishes the failing setup boundary from the last completed boundary and from the unentered stop phase, while the invocation remains failed

#### Scenario: Failure carries secret-bearing arbitrary data

- **WHEN** a setup dependency rejects with credentials or private data in its message, nested cause, aggregate members or attached output fields
- **THEN** only allowlisted phase and reason facts are exposed, none of those data appear in diagnostics or the sanitized rejection, and the failure is not converted into success

#### Scenario: Setup succeeds

- **WHEN** all setup boundaries complete
- **THEN** evidence records completion and the original audit/privacy verification proceeds without a retry, changed deadline, changed ordering or substituted acceptance assertion

#### Scenario: Nested setup rejects after an inner boundary completed

- **WHEN** a child operation completes but its enclosing setup operation later rejects
- **THEN** the completed child is not misreported as the failure, the unfinished enclosing boundary is retained, and cleanup cannot overwrite the first failure

#### Scenario: Diagnostic evidence cannot be retained

- **WHEN** the diagnostic output or retention boundary fails while reporting setup failure
- **THEN** the original safe primary-failure facts remain available where possible, evidence loss is explicit, and neither setup nor cleanup is reported successful because observation failed

### Requirement: Setup diagnostics preserve independent cleanup and historical uncertainty

Setup observation SHALL preserve the first failing boundary separately from subsequent owned drainage or cleanup failures. It SHALL NOT expand cleanup authority or report successful retirement from a failed or unavailable observation. Historical failures without retained boundary facts SHALL remain explicitly unknown; later successful qualification SHALL NOT be represented as their root-cause repair.

#### Scenario: Primary failure and cleanup failure coexist

- **WHEN** setup fails and an independent owned cleanup operation also fails
- **THEN** the safe evidence preserves both failure classes without losing the first setup boundary or exposing either raw exception, and acceptance remains failed with cleanup unconfirmed

#### Scenario: Cleanup succeeds after setup failure

- **WHEN** the original setup fails but its exact-owned cleanup completes
- **THEN** evidence keeps the original failed verdict distinct from successful cleanup and does not authorize unrelated deletion

#### Scenario: A later full qualification succeeds

- **WHEN** original complete Docker discovery and standalone deployment qualification succeed on a new reviewed candidate
- **THEN** that candidate's results are recorded separately, while the earlier setup cause remains unknown unless a causally matched failing-before and passing-after observation establishes it
