# built-artifact-verification Specification

## Purpose

Verify the actual built platform against a real invocation-exclusive Docker runtime without endangering another platform owner's in-flight resources on the verification host.

## Requirements

### Requirement: Built verification owns its Engine before reconciliation

The built-artifact verification command SHALL establish invocation-exclusive real Engine, container-runtime and kernel network ownership before starting production main. It SHALL NOT use a caller-configured shared Engine, a one-time empty inventory, a cooperative command-only lock, daemon bridge/firewall flags alone, a fake resolver or skipped reconciliation as isolation evidence. Unavailable prerequisites SHALL fail before production main or shared Engine/kernel network mutation.

#### Scenario: Concurrent employee startup survives

- **WHEN** another real owner is held after its employee bridge exists and before its canonical container is created, and built-artifact verification runs concurrently
- **THEN** verification uses a distinct real Engine, the exact original bridge remains present, and the original startup completes after release

#### Scenario: Isolation cannot be acquired

- **WHEN** a supported isolation prerequisite is missing or private-runtime identity verification fails
- **THEN** the command fails without launching production main or mutating the shared Engine

#### Scenario: Caller default bridge survives the private runtime

- **WHEN** actual built verification starts and retires its private daemons while the caller's network namespace contains a default Docker bridge
- **THEN** that bridge retains its exact link identity, both private daemons occupy a different network namespace, and no caller network interface is created, deleted or reconfigured

#### Scenario: Kernel network isolation is missing

- **WHEN** process/storage isolation exists but the runtime still shares the caller's network namespace
- **THEN** verification refuses before launching either daemon or changing network state

### Requirement: Isolation preserves built-artifact acceptance

Verification SHALL run the actual built main and its awaited reconciliation, observe healthy HTTP, validate the exact database schema and migration ledger versions1,2 and3, and run every existing HTTP smoke case as a nonroot application. It SHALL retain invocation-owned process and data cleanup without importing shared images or widening smoke into employee startup.

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

### Requirement: Development watch startup accepts an absent optional environment file

The foreground development command SHALL reach platform health when required configuration and runtime prerequisites are supplied without a local environment file. It SHALL retain the existing web build and native source-module reload, and SHALL use native environment-file parsing and inherited-environment precedence when the file is present. It SHALL NOT create an environment file or modify production/background entrypoints to satisfy this contract.

#### Scenario: Environment file absent at launch

- **WHEN** `pnpm dev` starts on Node24.13.1/pnpm10.34.6 without `.env`, with valid externally supplied platform configuration and a usable real Docker Engine
- **THEN** the platform reaches health without a missing-path watcher failure or creating `.env`
- **AND** a watched source change restarts the owned application and returns to health

#### Scenario: Environment file present at launch

- **WHEN** the foreground command starts with an owned nonsecret environment file
- **THEN** native loading provides its configuration, explicit inherited values retain precedence, and watched source changes still restart the application
- **AND** an existing invalid or unreadable input is not silently replaced with a missing-file fallback

#### Scenario: Foreground ownership is released

- **WHEN** the invocation is interrupted after readiness or reload
- **THEN** its native watcher and application settle and release their listener without a second application supervisor or fabricated successful shutdown
- **AND** a file first created after an env-less launch requires restarting the development command; automatic discovery of a newly created env file is not added

### Requirement: Background start ownership verification retains safe timeout evidence

The background development lifecycle integration SHALL keep its initial source-main ownership predicate, 5000ms bound and leading timeout text, and on timeout SHALL attach only closed-set evidence. That evidence SHALL name the start command's state, exit code, signal and relative close time; the first-observed relative times of the private lifecycle lock, built web entry, main log and a valid PID; and the final pidfile state. Scenario cleanup SHALL record each step's outcome independently and SHALL NOT replace the first scenario failure. No raw output, environment, credentials or log content SHALL enter the evidence.

#### Scenario: Startup held before PID publication

- **WHEN** the Engine preflight is held beyond the ownership bound
- **THEN** the failure keeps the original timeout text and reports lock and web build observed, no main log or PID, the command still running and the pidfile missing
- **AND** cleanup independently confirms command settlement, no surviving main, Engine closure and private root removal

#### Scenario: Startup exits before PID publication

- **WHEN** the Engine preflight fails
- **THEN** the evidence reports the command closed with its exit code and no PID observed

#### Scenario: Unconfirmed retirement retains the private root

- **WHEN** command settlement or main retirement is not confirmed during cleanup
- **THEN** the private root with its pidfile, lock and log is retained and the root step is reported failed, while the first scenario failure stays primary

#### Scenario: Evidence stays secret-free

- **WHEN** evidence is produced
- **THEN** it contains no fixture credential, socket path, environment value or log content

### Requirement: Source-main startup verification retains graceful-stop failure evidence

When startup verification of the actual source main process requests graceful shutdown and the process then exits nonzero or by signal, the printed failure message SHALL name the actual exit code and signal and include the bounded tail (at most 8192 characters, with an explicit truncation marker) of the process's already-captured stderr. If the main observation had already completed, its health status, exit code and bounded stderr SHALL appear in that same message; if the observation had failed, its original error SHALL remain attached as the reported failure's `cause`. The graceful-stop criterion (stop requested only while alive; any nonzero code or non-null signal fails), signal semantics, deadlines and consumer assertions SHALL remain unchanged. The evidence classifies only the exit class (silent nonzero exit, nonzero exit with an error dump, or signal termination); it SHALL NOT claim a cause or a source line.

#### Scenario: Graceful stop ends nonzero after a successful observation

- **WHEN** the observed main served health and, after the stop request, exits with code 1 and stderr text
- **THEN** the verification fails with a message naming code 1, signal null, the stderr tail, and the observation's health status and exit code

#### Scenario: Graceful stop ends by signal after an observation error

- **WHEN** the observation itself failed and the stop request then ends the process by a signal
- **THEN** the verification fails with a message naming that signal, and the original observation error is its `cause`

#### Scenario: Graceful stop succeeds

- **WHEN** the process exits with code 0 and no signal after the stop request, or had already exited before it
- **THEN** the observation result is returned, or the original observation error is rethrown as the same object
