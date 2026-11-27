## MODIFIED Requirements

### Requirement: Observer create-deadline failures retain attributable timing evidence

When the compiled observer child's non-stalling create request fails within its deadline, the verification failure SHALL report, alongside the unchanged assertion, a diagnostic containing: the child's call, request-issued and failure times; the engine fixture's create receipt, body-end, response-finish and response-close times; the engine's persisted and dispatched state and recorded request methods and paths; the worker's maximum event-loop delay over the scenario; and bounded child stdout and stderr. All times SHALL come from the host's system-wide monotonic clock so that child and engine values are comparable, and the child timing SHALL be reported as its own field rather than only inside truncated output. Successful runs SHALL add no child output. The non-stalling create's deadline SHALL be the scenario's ordinary 2000 ms request deadline: that case does not test cancellation, and a short deadline already runs during the synchronous submission work before the request is sent (#746: 212 ms). The stalling case SHALL keep its 200 ms deadline and real cancellation. When the stalling case fails, including after an abort before the engine received its create, the same diagnostic SHALL carry the child's call, request-issued and failure times. A passing stalling case SHALL add no child output. Request ordering and every assertion SHALL remain unchanged, and the evidence SHALL NOT claim a cause.

#### Scenario: Create aborted after the engine received it

- **WHEN** the non-stalling child source runs against an engine that receives the create but never completes its response, so the real 2000ms abort fires
- **THEN** the failure diagnostic contains a parsed child timing with `called <= issued <= settled`, an engine `received` time, `persisted: true`, a dispatched state, `responseClosed` recorded and `responseFinished` null

#### Scenario: Engine never received the create

- **WHEN** the diagnostic is formatted for an outcome with no engine create receipt
- **THEN** the engine `received` field is null and `persisted` is false, with the child timing and requests still reported

#### Scenario: Successful and stalling runs are unaffected

- **WHEN** the create succeeds, or the stalling case is cancelled as designed
- **THEN** child stderr stays empty and stdout, requests and cleanup assertions are unchanged

#### Scenario: Slow synchronous submission in a non-stalling case

- **WHEN** the synchronous work between the creation of the non-stalling create's deadline and the request write takes longer than 200 ms
- **THEN** the create still reaches the engine and the case passes with its unchanged criteria

#### Scenario: The stalling case aborts before the request is sent

- **WHEN** the stalling case's 200 ms create deadline fires before the engine receives the create
- **THEN** the failure diagnostic contains a parsed child timing with `called <= issued <= settled` and an engine `received` of null
