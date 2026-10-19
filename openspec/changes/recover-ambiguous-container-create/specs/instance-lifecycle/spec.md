## ADDED Requirements

### Requirement: Durable recovery of ambiguous container creation

Before submitting final user-container creation, the platform SHALL durably bind that attempt to nonsecret provenance. If its response or subsequent inspection is interrupted, the platform SHALL retain an explicit non-routable failure until the attempt is safely resolved. A fresh owner after platform restart SHALL automatically recover a matching never-started attempt through awaited reconciliation, preserving the user's volumes and unrelated resources. Recovery SHALL NOT adopt or start the abandoned container; employee startup remains explicit.

#### Scenario: Lost create response survives platform restart

- **WHEN** the Engine creates the requested container but the platform loses its response before committing an instance row, then the platform restarts
- **THEN** the fresh owner uses persisted attempt provenance to verify and remove only that exact never-started container and its verified captured bridge, retaining both data volumes
- **AND** the resulting safe error state permits an explicit retry using those same volumes, without manual fixture deletion or database repair

#### Scenario: Inspection or persistence fails after a learned identity

- **WHEN** creation returns an immutable identity but post-create inspection or the instance/audit transaction fails
- **THEN** the durable attempt retains the learned identity and only an unchanged matching attempt can be recovered
- **AND** a lost deletion reply, later network failure or failed final transaction remains recoverable after another owner restart without deleting unrelated resources or duplicating successful audits

#### Scenario: Cancellation and deadline preserve ownership

- **WHEN** a startup deadline, service cancellation or transport failure interrupts submitted creation while another same-user operation is queued
- **THEN** the original queue retains actual work ownership through settlement, no abandoned container is started, and stop/disable cannot falsely acknowledge complete cleanup
- **AND** other users remain independent and shutdown waits for actual owned work before closing SQLite

#### Scenario: Identity mismatch remains quarantined

- **WHEN** a candidate lacks the matching attempt nonce, changes immutable ID/image/account or expected mounts/network, is running or previously started, or the current account/instance snapshot changes
- **THEN** recovery fails explicitly without deleting or renaming the candidate, its volumes, unrelated endpoints or the durable attempt
- **AND** canonical-name and user-label matches alone never grant recovery authority; historical unindexed resources without durable provenance are not adopted

#### Scenario: Unknown absence is not cleanup proof

- **WHEN** a submitted attempt has no learned container ID and no candidate is currently observable
- **THEN** the platform retains explicit uncertainty rather than treating a404 or elapsed time as proof that the Engine cannot finish the submission later
- **AND** subsequent observation of the matching never-started resource enables the same identity-bound recovery path

#### Scenario: Durable state never exposes secrets or stale routing

- **WHEN** a failed attempt is observed through status, gateway, stop or a new owner
- **THEN** it is not reported as an ordinary stopped instance or routed to an obsolete endpoint, and no credential, raw inspect document or environment content is exposed or stored in the attempt
- **AND** normal successful instance creation consumes its attempt atomically with the existing creation audit, while verified failure recovery records only the existing safe startup-failure audit and no fabricated stopped audit
