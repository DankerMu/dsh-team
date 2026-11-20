## MODIFIED Requirements

### Requirement: Every shared-Engine producer has attributable submission evidence

Custody SHALL distinguish actual shared-Engine mutations from observations and non-Docker test executables. Each covered producer SHALL publish its submission before dispatch through one canonical verification protocol. Unknown transport or completion publication SHALL remain unresolved after process exit or resource absence. Precisely qualified terminal rejection responses SHALL retain their original rejection semantics without being confused with uncertain submission. Existing browser acquisition and private-Engine retirement authority SHALL NOT be used as proof of shared-daemon completion.

#### Scenario: A created resource is cleaned after its response is lost

- **WHEN** an actual mutation is submitted, its response is incomplete or lost, and exact-owned cleanup later observes absence
- **THEN** the original submission remains unresolved and cleanup is not confirmed solely from that absence
- **AND** unrelated resource identity and the original failure are preserved

#### Scenario: Settled bytes are visible after completion publication fails

- **WHEN** a writer appends a settled row but its required fsync or descriptor close fails
- **THEN** the pre-dispatch pending marker remains and both current and fresh-process custody assessment reject confirmation despite readable settled bytes
- **AND** a qualified Docker rejection retains its original error identity while successful-operation publication failure is reported separately

#### Scenario: A writer dies at the completion boundary

- **WHEN** a writer dies before removing its exact pending marker, or marker creation/removal fails
- **THEN** no live or later successful writer can turn that attempt into confirmed settlement through inventory absence or another request's completion
- **AND** removal is permitted only after the permitted operation-specific outcome's write, fsync and close succeed: a settled row for ordinary operations, or the explicitly authorized client-closed/operation-unknown record for contained browser exec; independent writer retirement remains required for final assessment

#### Scenario: A qualified rejection is observed at canonical response headers

- **WHEN** the original client rejects `POST /networks/create` with403, `POST /networks/<target>/connect` with400, `POST /containers/<target>/stop` with304, or exact `DELETE /containers/<target>`, `/networks/<target>` or `/volumes/<target>` with404
- **THEN** only that request's submission may settle at the canonical header-error boundary while the same error object is rethrown
- **AND** independent resource-state checks remain mandatory and no earlier unresolved request is completed by that rejection

#### Scenario: A network connect is refused by validation

- **WHEN** the original client's `POST /networks/<target>/connect` is rejected with400, for example because the container shares another container's network namespace
- **THEN** only that submission settles at the canonical header-error boundary and the same error object is rethrown; the 400 is a definitive Docker reply, a partially created endpoint is Docker's to roll back, and independent resource-state checks remain the backstop
- **AND** a connect rejected with any other status, a lost connect response, and a400 on a sibling endpoint such as `POST /networks/<target>/disconnect` remain unresolved

#### Scenario: A status matches but its request or error provenance does not

- **WHEN** a matching status appears on another method/endpoint, a noncanonical error imitates that status, or a successful response is malformed/truncated
- **THEN** the submission remains unresolved and cannot borrow the qualified rejection matrix
- **AND** observing or cancelling exact `POST /containers/<target>/wait` does not invent a mutation

#### Scenario: A caller declares one independently proven CLI exit status

- **WHEN** the resource-OOM pressure exec declares exit status137 and its directly spawned fixed-PATH `docker` CLI (not a wrapper) exits normally with exactly137, no error and no signal
- **THEN** only that submission may publish its ordinary settled row while the fixture's independent OOM proof remains mandatory
- **AND** an undeclared137, another status, a signal or error accompanying137, a spawn error or a lost response remains unresolved

#### Scenario: A controlled executable never dispatches to Docker

- **WHEN** a verification fault substitutes an owned non-Docker process at the external executable boundary
- **THEN** the original caller timer, kill and child-closure oracle remain active without inventing a daemon submission
- **AND** the same mechanism still rejects genuinely submitted operations whose responses are lost
