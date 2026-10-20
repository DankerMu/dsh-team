# Spec Delta

## Purpose

Preserve ordinary trusted full-Docker verification ownership, complete safe output and honest terminal outcomes across SSH observer disconnection without widening test, resource or model authorization.

## ADDED Requirements

### Requirement: Test work begins under durable reviewed invocation authority

The trusted full-Docker entrypoint SHALL persist private invocation authority before admitting test work, binding the full reviewed SHA, exact original command, canonical remote checkout and a verifiable owner identity stronger than a process ID alone. Reconnection SHALL select that same invocation. Missing, malformed, foreign or changed authority SHALL fail closed without adopting a process or resource.

#### Scenario: A prepared reviewed invocation starts

- **WHEN** the trusted operator starts the full command from its prepared frozen checkout
- **THEN** a private durable manifest identifies the reviewed revision, command, checkout and owner before test work begins
- **AND** status queries identify the same invocation rather than an inferred current process

#### Scenario: The checkout or custody identity differs

- **WHEN** the supplied revision, recorded checkout, owner birth or private record identity does not match
- **THEN** admission or mutation is refused without starting replacement work or signalling another process

### Requirement: Observer disconnection does not become a test verdict

The remote owner SHALL remain independent of an observing SSH connection. A disconnected or timed-out observer SHALL NOT be interpreted as remote completion, cancellation, command success or cleanup success. Reconnected observers SHALL retrieve the same invocation's current state and durable output/result. An absent owner without a valid terminal record SHALL remain explicitly unknown.

#### Scenario: SSH disconnects while the verification child is live

- **WHEN** the observing SSH client ends before the owned child settles
- **THEN** the remote invocation remains independently traceable and continues owning its work
- **AND** reconnecting by its identity reports running or its actual later terminal result, never an invented successful result

#### Scenario: Owner disappears without terminal evidence

- **WHEN** the recorded owner is no longer live and no valid matching terminal receipt exists
- **THEN** status reports unknown/incomplete ownership and retains evidence rather than treating process absence as a passing test or authorizing takeover

### Requirement: Complete output and terminal facts remain private and independent

The owner SHALL incrementally retain complete stdout and stderr with ordered per-stream content, bounded-memory flow control and private permissions. Credentials, proxy values and unrelated environment secrets SHALL NOT enter persisted output or receipts. Terminal publication SHALL be atomic and separately identify the original command's exit or signal, interruption, output completeness and cleanup outcome. Output loss, write failure or malformed terminal evidence SHALL prevent acceptance.

#### Scenario: The original command fails and cleanup succeeds

- **WHEN** the full command exits nonzero while its owned resources retire
- **THEN** the durable result preserves that nonzero command outcome separately from successful cleanup
- **AND** reconnecting retrieves its complete safe output rather than replacing the failure with cleanup success

#### Scenario: Sensitive values cross output chunk boundaries

- **WHEN** output contains secret or proxy canaries split across writes
- **THEN** those values are absent from durable output and metadata while nonsecret output retains its per-stream order

#### Scenario: Output cannot be retained completely

- **WHEN** an output stream or its private storage fails before completion
- **THEN** the result reports incomplete evidence and cannot qualify as successful verification even if the command later exits zero

### Requirement: Explicit cancellation preserves exact ownership and uncertainty

Only an explicit matching invocation cancellation request SHALL authorize the owner to signal its captured work after fresh identity checks. The owner SHALL settle submitted work before claiming cleanup and SHALL preserve canonical browser acquisition and Docker ownership rules. PID-only signalling, prefix/global rescue, foreign-resource deletion and uncertain-creation cleanup claims SHALL remain forbidden.

#### Scenario: A matching live invocation is cancelled

- **WHEN** the operator explicitly cancels an invocation whose owner and child identities still match
- **THEN** only its owned work receives cancellation and the real exit/signal is retained
- **AND** an unrelated live sentinel survives, with cleanup reported separately

#### Scenario: Cancellation authority or producer settlement is unknown

- **WHEN** recorded identity is missing or changed, or interrupted creation cannot be confirmed settled
- **THEN** the operation refuses unsafe mutation or records unconfirmed cleanup and retains private authority
- **AND** an empty discovery snapshot does not convert uncertainty into successful retirement

### Requirement: Custody preserves the existing trusted acceptance boundary

The custody entrypoint SHALL run the unchanged original full Docker discovery and preserve existing build, test and SSH deadlines, ordinary proxy/image policy and trusted reviewed-head admission. It SHALL NOT invoke a real model, modify the restricted-model owner, retry failed tests or publish success automatically. Trusted acceptance SHALL still require actual exact-head full execution plus independent owned-resource retirement and unchanged protected host evidence.

#### Scenario: Delivered custody completes real full verification

- **WHEN** the reviewed candidate is qualified through the delivered entrypoint on the trusted host
- **THEN** the original complete Docker command and existing checks determine its result
- **AND** independent cleanup/host evidence is required before owner attestation, without borrowing another revision's pass

#### Scenario: A narrower diagnostic passes

- **WHEN** an owned process fixture or a narrowed diagnostic succeeds but complete acceptance has not passed
- **THEN** that evidence remains labelled diagnostic and cannot substitute for the required full run
