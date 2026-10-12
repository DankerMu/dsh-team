# Browser runtime verification

## Purpose

Make browser runtime failures attributable without changing the behavior being verified, exposing credentials or weakening acceptance. Qualification must distinguish a genuine owner-level repair from a passing diagnostic, stale candidate evidence or an ignored network failure.

## ADDED Requirements

### Requirement: Browser failure evidence preserves the failed exchange

When browser navigation or application readiness fails, the verifier MUST retain bounded request/response/failure context alongside its existing screenshot/control evidence. Context MUST identify the relevant request and redirect hop, safe path, resource type, observed status or failure code, cancellation state and relative timing. Evidence collection or persistence failure MUST NOT replace the original failure or turn it into success.

#### Scenario: Document succeeds but a required script fails

- **WHEN** the document receives200 and a required script fails with an uncanceled network error before application readiness
- **THEN** retained evidence distinguishes the successful document from the failed script and preserves the original nonzero acceptance outcome

#### Scenario: Evidence output fails

- **WHEN** writing failure evidence fails after the browser scenario has already failed
- **THEN** the original scenario failure remains authoritative and the evidence failure is reported safely without claiming complete evidence

### Requirement: Evidence is private, bounded and honest about loss

Persisted diagnostic evidence MUST exclude credentials, cookies, headers, URL queries, response bodies and raw network-address inventories. Collections MUST have explicit bounds and report drops or collector failures. Host/Docker correlation MUST retain enough selected identity and timing provenance to distinguish owned, foreign and unresolved events; unresolved identity MUST NOT be labelled foreign merely because it was not registered.

#### Scenario: Sensitive traffic and excess events

- **WHEN** traffic contains secret-bearing fields or exceeds the evidence limit
- **THEN** those fields are absent from persisted evidence, retained rows remain within the declared bound, and loss is explicitly counted

#### Scenario: Attribution is incomplete

- **WHEN** a host event is near a browser failure but the interface or resource owner cannot be established
- **THEN** the report records an unresolved correlation rather than a causal-owner conclusion

### Requirement: Observation preserves all existing consumers

Adding diagnostics MUST NOT replace another observer's events, change navigation or startup timing policy, alter successful acceptance semantics, or suppress original failures. Session creation receipts, model-refusal checks, permission checks and owned-resource cleanup MUST retain their existing guarantees.

#### Scenario: Multiple browser evidence consumers

- **WHEN** failure collection and a scenario-specific observer consume the same protocol event
- **THEN** both receive the required event information and the scenario retains its original success or failure result

### Requirement: A blocker repair requires causal and behavioral proof

The verifier's network blocker MUST be repaired at a demonstrated owner. A successful isolated or instrumented run, temporal proximity, extra retries, increased deadlines, arbitrary delay or ignored browser error MUST NOT qualify as a repair. Experimental mutations MUST affect only newly created invocation-owned test resources.

#### Scenario: A controlled cause is removed

- **WHEN** a discriminating owned-resource scenario establishes the interruption mechanism and a repair is applied
- **THEN** the original failing behavior no longer occurs under that scenario, the unchanged real browser acceptance passes, and unrelated resources remain unchanged

#### Scenario: The authorized diagnosis bound is reached

- **WHEN** the approved bounded round ends without causal repair and required evidence
- **THEN** the workflow remains blocked with retained failures instead of retrying until green or declaring the blocker complete

### Requirement: Runtime qualification binds to the final candidate

Final acceptance MUST use the original full test discovery and existing error/deadline gates on the final exact candidate, with complete environment identity and owned-resource cleanup. For this intermittent failure, one planned same-candidate stability run MUST follow the first successful full qualification. Diagnostic variants and older-candidate results MUST remain separately labelled and MUST NOT be substituted for final evidence.

#### Scenario: A diagnostic passes while original acceptance fails

- **WHEN** an instrumented or isolated scenario passes but the original full suite fails on the final candidate
- **THEN** the candidate remains unqualified and both outcomes are retained
