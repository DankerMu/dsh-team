## ADDED Requirements

### Requirement: Observer create-deadline failures retain attributable timing evidence

When the compiled observer child's non-stalling create request fails within its deadline, the verification failure SHALL report, alongside the unchanged assertion, a diagnostic containing: the child's call, request-issued and failure times; the engine fixture's create receipt, body-end, response-finish and response-close times; the engine's persisted and dispatched state and recorded request methods and paths; the worker's maximum event-loop delay over the scenario; and bounded child stdout and stderr. All times SHALL come from the host's system-wide monotonic clock so that child and engine values are comparable, and the child timing SHALL be reported as its own field rather than only inside truncated output. Successful runs SHALL add no child output. The create deadline, the stalling case's real cancellation, request ordering and every assertion SHALL remain unchanged, and the evidence SHALL NOT claim a cause.

#### Scenario: Create aborted after the engine received it

- **WHEN** the non-stalling child source runs against an engine that receives the create but never completes its response, so the real 200ms abort fires
- **THEN** the failure diagnostic contains a parsed child timing with `called <= issued <= settled`, an engine `received` time, `persisted: true`, a dispatched state, `responseClosed` recorded and `responseFinished` null

#### Scenario: Engine never received the create

- **WHEN** the diagnostic is formatted for an outcome with no engine create receipt
- **THEN** the engine `received` field is null and `persisted` is false, with the child timing and requests still reported

#### Scenario: Successful and stalling runs are unaffected

- **WHEN** the create succeeds, or the stalling case is cancelled as designed
- **THEN** child stderr stays empty and stdout, requests and cleanup assertions are unchanged
