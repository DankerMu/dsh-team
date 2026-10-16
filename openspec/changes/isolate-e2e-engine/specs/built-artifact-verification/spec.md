## Purpose

Verify the actual built platform against a real invocation-exclusive Docker runtime without endangering another platform owner's in-flight resources on the verification host.

## ADDED Requirements

### Requirement: Built verification owns its Engine before reconciliation

The built-artifact verification command SHALL establish invocation-exclusive real Engine and container-runtime ownership before starting production main. It SHALL NOT use a caller-configured shared Engine, a one-time empty inventory, a cooperative command-only lock, a fake resolver or skipped reconciliation as isolation evidence. Unavailable prerequisites SHALL fail before production main or shared Engine mutation.

#### Scenario: Concurrent employee startup survives

- **WHEN** another real owner is held after its employee bridge exists and before its canonical container is created, and built-artifact verification runs concurrently
- **THEN** verification uses a distinct real Engine, the exact original bridge remains present, and the original startup completes after release

#### Scenario: Isolation cannot be acquired

- **WHEN** a supported isolation prerequisite is missing or private-runtime identity verification fails
- **THEN** the command fails without launching production main or mutating the shared Engine

### Requirement: Isolation preserves built-artifact acceptance

Verification SHALL run the actual built main and its awaited reconciliation, observe healthy HTTP, validate the exact database schema and migration ledger versions1 and2, and run every existing HTTP smoke case as a nonroot application. It SHALL retain invocation-owned process and data cleanup without importing shared images or widening smoke into employee startup.

#### Scenario: Successful isolated verification

- **WHEN** the private runtime is ready and the built platform starts
- **THEN** health, schema, ledger and all smoke assertions pass against the actual built application before successful completion is reported

### Requirement: Verification runtime lifetime remains owned

The command SHALL settle its scenario and runtime processes and clean only captured invocation-owned resources. Cancellation, invoking-parent loss and partial runtime startup SHALL not authorize deletion of unrelated resources. Unconfirmed or forced cleanup SHALL not be reported as successful graceful completion; diagnostic retention SHALL not expose credentials.

#### Scenario: Partial runtime startup fails

- **WHEN** one private daemon starts but the remaining runtime cannot become ready
- **THEN** main is not admitted, already-created owned processes are retired, and the command fails without shared-resource mutation

#### Scenario: Invoking process disappears

- **WHEN** the invoking process disappears while the private runtime is active
- **THEN** its lifetime channel closes, the owned scenario and daemons are retired, and unrelated host processes and resources survive

#### Scenario: Privileged supervisor is killed

- **WHEN** the private runtime supervisor terminates without executing normal cleanup
- **THEN** its contained process tree cannot remain running, and retained invocation paths are not misreported as a successful clean run
