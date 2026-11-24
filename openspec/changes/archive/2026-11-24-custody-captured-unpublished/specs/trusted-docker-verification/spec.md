## ADDED Requirements

### Requirement: A captured start whose command identity is never recorded is claimed like an uncaptured one

The custody fixture SHALL record a captured start's authority only after its command-identity wait ends. When that wait fails, or the case deadline or an unreadable receipt ends it first, cleanup SHALL claim the invocation through the uncaptured mechanism:

- freeze the owner;
- bind its command from the `child.json` receipt, or from a scan of the stopped owner's children;
- settle the owner;
- settle the bound command's group;
- report the command pid or that no command started.

A captured start that ends with `result.json` and no command SHALL keep its current handling.

#### Scenario: The owner started a command but never published it

- **WHEN** a captured start's identity wait expires after its owner spawned the command
- **THEN** the case fails naming the owner, the cleanup report names the command pid, and the command's process group is absent after cleanup

#### Scenario: The receipt is written after the wait expired

- **WHEN** the owner writes `child.json` after the identity wait expired and before cleanup
- **THEN** cleanup settles the command's group from that receipt and reports its pid
