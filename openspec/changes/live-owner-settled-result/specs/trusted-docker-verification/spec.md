## MODIFIED Requirements

### Requirement: A captured start whose command identity is never recorded is claimed like an uncaptured one

The custody fixture SHALL record a captured start's authority only after its command-identity wait ends. When that wait fails, or the case deadline or an unreadable receipt ends it first, cleanup SHALL claim the invocation through the uncaptured mechanism:

- freeze the owner;
- bind its command from the `child.json` receipt, or from a scan of the stopped owner's children;
- settle the owner;
- settle the bound command's group;
- report the command pid or that no command started.

A captured start whose identity wait itself ends on `result.json` with no command SHALL keep its current handling.

When the owner has exited without a `child.json` receipt, its `result.json` — validated against this invocation's id and manifest digest — records a settled command (`command.settled` true) and cleanup reaches that check only after confirming the owner gone and finding no command receipt, cleanup SHALL claim the invocation as a finished command: it SHALL hand back the authority, report `command finished`, delete the invocation's temporary root, and add no "authority retained" failure. A `result.json` that is missing, unreadable, invalid, or records an unsettled command SHALL keep the authority retained exactly as before.

When the owner is still alive and frozen, no `child.json` receipt exists and the scan of its children completes with no command and no in-flight or ambiguous child (at most helpers inside the owner's own process group), cleanup SHALL read the same validated `result.json`. A scan that fails, does not list the owner, finds an ambiguous or still in-flight child, or cannot observe the command SHALL keep the command unidentified with the authority retained, whatever `result.json` says. If that `result.json` records a settled command, cleanup SHALL claim the invocation as a finished command exactly as for an exited owner. Otherwise cleanup SHALL report that no command started, as before. A command that the scan finds SHALL stay bound by pid whatever `result.json` says.

#### Scenario: The owner started a command but never published it

- **WHEN** a captured start's identity wait expires after its owner spawned the command
- **THEN** the case fails naming the owner, the cleanup report names the command pid, and the command's process group is absent after cleanup

#### Scenario: The receipt is written after the wait expired

- **WHEN** the owner writes `child.json` after the identity wait expired and before cleanup
- **THEN** cleanup settles the command's group from that receipt and reports its pid

#### Scenario: The owner finished after the identity wait expired

- **WHEN** a captured start's identity wait expires and the owner then writes a valid `result.json` with a settled command and exits without `child.json`
- **THEN** cleanup reports `command finished`, hands back the authority and deletes the invocation's temporary root
- **AND** the case reports only its own failure

#### Scenario: An unsettled or invalid result keeps the authority

- **WHEN** the owner exits without `child.json` and its `result.json` records an unsettled command, or does not validate for this invocation
- **THEN** the authority stays retained with the report `command unidentified (owner gone without receipt)`

#### Scenario: A live owner already wrote a settled result

- **WHEN** cleanup freezes an owner that is still alive, has no `child.json`, whose completed scan finds no command and no in-flight or ambiguous child, and that has written a valid `result.json` with a settled command
- **THEN** cleanup reports `command finished`, hands back the authority and adds no "authority retained" failure

#### Scenario: A live owner with a settled result still has a command

- **WHEN** the frozen owner's scan finds a command although its `result.json` records a settled command
- **THEN** cleanup binds that command by pid and reports it

#### Scenario: A live owner without a settled result reports no command

- **WHEN** the frozen owner has no `child.json`, its completed scan finds no command and no in-flight or ambiguous child, and its `result.json` is missing, invalid for this invocation, or records an unsettled command
- **THEN** cleanup reports that no command started, as before

#### Scenario: An uncertain scan of a live owner keeps the authority

- **WHEN** the frozen owner's scan finds an ambiguous child although its `result.json` records a settled command
- **THEN** the command stays unidentified and the authority is retained

### Requirement: Uncaptured custody cleanup retires an unpublished command group

When the trusted custody fixture's cleanup finds an invocation whose start was never captured, it SHALL first confirm the owner's identity and freeze the owner.

While the owner is frozen, cleanup SHALL bind the identity of the command the owner started. The identity comes from the command receipt, or, when no receipt exists, from the owner's direct child that leads its own process group and runs the verification command.

Cleanup SHALL then retire the owner, and SHALL retire the command's group after the owner. It SHALL NOT leave the owner stopped, except when the owner's identity can no longer be confirmed after its retirement failed. In that case it SHALL NOT signal the unconfirmed pid, and SHALL report the retirement failure.

Cleanup SHALL report the command it bound, or that no command was started. In-flight, ambiguous or failed identification, and an owner already gone with no command receipt, SHALL keep the authority and SHALL NOT be reported as absence. The exceptions are an owner already gone, and a frozen owner whose completed scan finds no command and no in-flight or ambiguous child, when its validated `result.json` records a settled command: cleanup SHALL claim it as a finished command, report `command finished`, and hand back the authority.

#### Scenario: Owner killed after starting its command but before publishing it

- **WHEN** a start is abandoned at the case deadline while its owner has started the command but not yet written its receipt
- **THEN** cleanup retires the owner and then the command's process group
- **AND** the uncaptured entry names the command

#### Scenario: No command was started

- **WHEN** the frozen, identity-bound owner has no started or in-flight command and no valid `result.json` records a settled command
- **THEN** cleanup retires the owner and reports that no command was started

#### Scenario: Identification is uncertain

- **WHEN** a child of the owner is still in flight, a child is ambiguous, the scan fails, or the owner is gone before it is frozen and neither a command receipt nor a valid settled `result.json` exists
- **THEN** cleanup keeps the authority, still kills an identity-bound owner, and does not report the command group absent
