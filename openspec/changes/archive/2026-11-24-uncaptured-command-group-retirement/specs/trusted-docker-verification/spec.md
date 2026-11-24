## ADDED Requirements

### Requirement: Uncaptured custody cleanup retires an unpublished command group

When the trusted custody fixture's cleanup finds an invocation whose start was never captured, it SHALL first confirm the owner's identity and freeze the owner.

While the owner is frozen, cleanup SHALL bind the identity of the command the owner started. The identity comes from the command receipt, or, when no receipt exists, from the owner's direct child that leads its own process group and runs the verification command.

Cleanup SHALL then retire the owner, and SHALL retire the command's group after the owner. It SHALL NOT leave the owner stopped, except when the owner's identity can no longer be confirmed after its retirement failed. In that case it SHALL NOT signal the unconfirmed pid, and SHALL report the retirement failure.

Cleanup SHALL report the command it bound, or that no command was started. In-flight, ambiguous or failed identification, and an owner already gone with no command receipt, SHALL keep the authority and SHALL NOT be reported as absence.

#### Scenario: Owner killed after starting its command but before publishing it

- **WHEN** a start is abandoned at the case deadline while its owner has started the command but not yet written its receipt
- **THEN** cleanup retires the owner and then the command's process group
- **AND** the uncaptured entry names the command

#### Scenario: No command was started

- **WHEN** the frozen, identity-bound owner has no started or in-flight command
- **THEN** cleanup retires the owner and reports that no command was started

#### Scenario: Identification is uncertain

- **WHEN** a child of the owner is still in flight, a child is ambiguous, the scan fails, or the owner is gone before it is frozen and no receipt exists
- **THEN** cleanup keeps the authority, still kills an identity-bound owner, and does not report the command group absent
