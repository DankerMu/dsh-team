# trusted-docker-verification Specification

## Purpose

Preserve ordinary trusted full-Docker verification ownership, complete safe output and honest terminal outcomes across SSH observer disconnection without widening test, resource or model authorization.

## Requirements

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

Only an explicit matching invocation cancellation request SHALL authorize the owner to signal its captured work after fresh identity checks. The owner SHALL settle submitted work before claiming cleanup and SHALL preserve canonical browser acquisition and Docker ownership rules. After the owner itself signalled its captured group, and only once that group, its producers and browser producers have settled, no submission writer remains live other than a registration's own exactly bound deployment platform, and the invocation identity is unchanged, the owner SHALL retire the resources registered in that invocation's private journal: exact registered names and labels only, the most recently first-registered run first. A registration that includes the fixed deployment platform SHALL be retired only while holding the host-wide deployment lock and only after that platform has been drained by SIGTERM to a confirmed clean exit and every submission reservation has then settled; if the lock is unavailable, the drain is unconfirmed or settlement remains pending, nothing of that registration SHALL be removed. The read-only cleanup assessment SHALL still alone decide confirmed or unconfirmed cleanup, and a cancelled run SHALL never be reported as passed. PID-only signalling, prefix/global rescue, foreign-resource deletion and uncertain-creation cleanup claims SHALL remain forbidden.

#### Scenario: A matching live invocation is cancelled

- **WHEN** the operator explicitly cancels an invocation whose owner and child identities still match
- **THEN** only its owned work receives cancellation and the real exit/signal is retained
- **AND** an unrelated live sentinel survives, with cleanup reported separately

#### Scenario: Cancellation interrupts work that registered resources

- **WHEN** a cancelled child had registered running containers and other resources in the invocation journal before its own cleanup could run
- **THEN** after settlement, with only the registration's own bound platform still live, the owner drains that platform under the deployment lock, confirms that every submission reservation has settled, retires exactly those registered resources, and the cleanup assessment reports confirmed
- **AND** the result stays failed with the cancellation signal and interruption, and an unregistered or label-mismatched resource with the same prefix survives

#### Scenario: The deployment platform does not drain cleanly

- **WHEN** the registered deployment platform exits nonzero or out of memory after SIGTERM, its submission reservation remains pending after exit, or the deployment lock is held elsewhere
- **THEN** no resource of that registration is removed, the lock file is not unlinked, and cleanup is reported unconfirmed

#### Scenario: Cancellation authority or producer settlement is unknown

- **WHEN** recorded identity is missing or changed, or interrupted creation cannot be confirmed settled
- **THEN** the operation refuses unsafe mutation or records unconfirmed cleanup and retains private authority
- **AND** an empty discovery snapshot does not convert uncertainty into successful retirement

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

- **WHEN** the original client rejects `POST /networks/create` with403, `POST /containers/<target>/stop` with304, or exact `DELETE /containers/<target>`, `/networks/<target>` or `/volumes/<target>` with404
- **THEN** only that request's submission may settle at the canonical header-error boundary while the same error object is rethrown
- **AND** independent resource-state checks remain mandatory and no earlier unresolved request is completed by that rejection

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

### Requirement: Isolated-browser execution retirement does not invent a daemon outcome

An isolated-browser exec submission SHALL bind its invocation, canonical browser authority and full immutable container ID before spawning. Its actual CLI outcome and any unknown daemon-operation outcome SHALL remain recorded. Only this narrowly typed operation MAY use independently verified loss of execution capability for cleanup assessment, without claiming daemon acknowledgement or rewriting an unknown request as settled. Generic submission assessment SHALL continue rejecting unknown outcomes.

#### Scenario: Canonical rescue interrupts an active browser exec

- **WHEN** the captured browser is canonically retired while its protocol exec is active
- **THEN** the original exec rejection and application/CDP stream assertions remain, and the actual CLI child closes before its outcome evidence is published
- **AND** only after unchanged authority, acquisition-producer and driver retirement, canonical container removal and fresh exact-ID absence may final evidence report operation outcome unknown separately from execution capability retired

#### Scenario: Unknown exec outcome is fully published

- **WHEN** an eligible contained exec's client-closed/operation-unknown record is successfully written, fsynced and closed
- **THEN** only its publication marker may be removed, while generic submission assessment continues to reject its unknown operation outcome
- **AND** only the independent final assessor may project execution capability retired after all required exact-retirement proof; failed publication keeps the marker and blocks both assessment paths

#### Scenario: Exec targets the already-retired captured browser

- **WHEN** a bound exec is attempted against that independently retired immutable ID
- **THEN** its rejection is preserved and no successful command or daemon acknowledgement is invented
- **AND** the same complete ownership, client-closure and exact-retirement evidence is still required for capability-retirement assessment

#### Scenario: Retirement evidence is incomplete or belongs to another scope

- **WHEN** the target is live or name-only, authority is missing/foreign/changed, exact inspection/removal fails, the producer/client remains uncertain, or outcome publication fails
- **THEN** cleanup remains unconfirmed without mutating the evidence or expanding cleanup authority
- **AND** this proof cannot settle create/build/network operations, arbitrary CLI failures or an ordinary lost-response mutation

### Requirement: Deployed application observation is private and generation-bound

Only invocation-generated test startup injection and private observation mounts MAY wrap the deployed platform's exact compiled DockerClient factory. Production source, production images, formal deployment configuration, HTTP bytes and socket routing SHALL remain unchanged. Necessary inert helper COPY/build-context and selective rescue-closure additions for the existing verification-browser image MAY preserve module completeness, but SHALL NOT change its base/runtime/library versions, browser configuration or credential/custody propagation. Initialization, request settlement and writer retirement SHALL be separate evidence. A registered participant SHALL bind the invocation and a unique platform generation; parent observation SHALL bind that generation to the immutable container identity. Per-request records SHALL contain only opaque correlation identities and fixed states.

#### Scenario: The platform performs a settled Docker mutation

- **WHEN** the registered preload actually wraps the exact original factory, the canonical client receives a complete valid terminal result, and the captured platform generation exits normally
- **THEN** its initialization, request settlement and participant completion are retained without altering client values, error types, cancellation or streams
- **AND** independent writer/container retirement is still required before final cleanup assessment

#### Scenario: Initialization or evidence publication is missing

- **WHEN** preload/factory interception is absent, a capability or journal identity differs, or submission publication fails
- **THEN** missing observation cannot become an empty successful journal and failed submission publication prevents dispatch
- **AND** malformed/incomplete evidence or abrupt producer death prevents confirmed cleanup

#### Scenario: The platform is recreated

- **WHEN** the exact drained platform is replaced while employee instances remain running
- **THEN** the replacement receives a newly registered generation and capability while old evidence is retained
- **AND** an old, duplicate or foreign initialization/completion cannot satisfy the new generation

#### Scenario: The same platform container is stopped and started

- **WHEN** the existing audit stops the exact platform container and then starts that same ID after verified normal exit
- **THEN** a fresh process-generation capability is published before start through the stable readonly bootstrap directory, and parent observation binds it to the new StartedAt/process incarnation
- **AND** the original stop/start commands, container identity, deadlines, restarted witness and timeout/no-start assertions remain unchanged
- **AND** neither the successor manifest nor normal restart clears predecessor uncertainty or lets an old process adopt the new generation

#### Scenario: Application work precedes parent incarnation binding

- **WHEN** the initialized platform begins Docker work before the parent has captured its running incarnation
- **THEN** every request is already durably registered under the reserved generation before dispatch, while participant confirmation remains blocked on verified binding
- **AND** missing binding or failed startup stays unconfirmed without adding bootstrap retries, waits or deadline extensions

#### Scenario: Normal process exit follows an unresolved Docker request

- **WHEN** the platform exits normally but a submitted Docker request lacks qualified settlement evidence
- **THEN** participant exit does not complete that request or establish daemon settlement
- **AND** its resources and evidence remain governed by existing exact ownership rules without expanded deletion authority

### Requirement: Custody preserves the existing trusted acceptance boundary

The custody entrypoint SHALL run the unchanged original full Docker discovery and preserve existing build, test and SSH deadlines, ordinary proxy/image policy and trusted reviewed-head admission. It SHALL NOT invoke a real model, modify the restricted-model owner, retry failed tests or publish success automatically. Trusted acceptance SHALL still require actual exact-head full execution plus independent owned-resource retirement and unchanged protected host evidence.

#### Scenario: Delivered custody completes real full verification

- **WHEN** the reviewed candidate is qualified through the delivered entrypoint on the trusted host
- **THEN** the original complete Docker command and existing checks determine its result
- **AND** independent cleanup/host evidence is required before owner attestation, without borrowing another revision's pass

#### Scenario: A narrower diagnostic passes

- **WHEN** an owned process fixture or a narrowed diagnostic succeeds but complete acceptance has not passed
- **THEN** that evidence remains labelled diagnostic and cannot substitute for the required full run

### Requirement: Command settlement waits a bounded window for genuine group absence

After the owned command's actual close, trusted custody SHALL observe its process group within one bounded observation window and SHALL record the command settled only on a genuine process-group absence (`ESRCH`). A group still present when the window expires SHALL remain unsettled. An EPERM observation SHALL never count as absence and SHALL be observed again within the window; if the final observation at expiry is EPERM the existing identity failure SHALL be recorded. Any other non-absence error SHALL keep the existing immediate identity failure. The window SHALL NOT retry, re-run or signal the command.

#### Scenario: A group member briefly outlives the command

- **WHEN** the command closes while a member of its process group is still running or not yet reaped, and that member exits within the window
- **THEN** the published terminal records `settled: true`, cleanup is assessed normally, and a duplicate cancellation reports the terminal result with exit 0

#### Scenario: The group does not become absent

- **WHEN** a group member is still present at window expiry
- **THEN** the terminal records `settled: false` with no identity failure (status `unknown`), preserving the original command exit and signal

#### Scenario: Group observation stays denied

- **WHEN** every observation in the window is denied (EPERM)
- **THEN** the terminal records `settled: false` and the identity failure, preserving the original command exit and signal

### Requirement: Custody regressions wait for readiness through a bounded fail-fast signal

Trusted custody integration regressions SHALL wait for owned process readiness only through an explicit, measurement-derived deadline that fits within each test's existing bound, and SHALL accept only a complete readiness record published atomically. While waiting they SHALL fail immediately, with sanitized terminal evidence, once the invocation has published its terminal result or its owner is absent, instead of waiting out the deadline.

#### Scenario: Readiness arrives late under load

- **WHEN** a leaf publishes its readiness record later than one second but within the explicit deadline
- **THEN** the regression proceeds to its custody assertions unchanged

#### Scenario: The invocation ends before readiness

- **WHEN** the owner publishes a terminal result or exits before readiness is observed
- **THEN** the wait fails immediately with sanitized terminal evidence rather than a generic timeout

### Requirement: Observer create-deadline failures retain attributable timing evidence

When the compiled observer child's non-stalling create request fails within its deadline, the verification failure SHALL report, alongside the unchanged assertion, a diagnostic containing: the child's call, request-issued and failure times; the engine fixture's create receipt, body-end, response-finish and response-close times; the engine's persisted and dispatched state and recorded request methods and paths; the worker's maximum event-loop delay over the scenario; and bounded child stdout and stderr. All times SHALL come from the host's system-wide monotonic clock so that child and engine values are comparable, and the child timing SHALL be reported as its own field rather than only inside truncated output. Successful runs SHALL add no child output. The create deadline, the stalling case's real cancellation, request ordering and every assertion SHALL remain unchanged, and the evidence SHALL NOT claim a cause.

#### Scenario: Create aborted after the engine received it

- **WHEN** the non-stalling child source runs against an engine that receives the create but never completes its response, so the real 200ms abort fires
- **THEN** the failure diagnostic contains a parsed child timing with `called <= issued <= settled`, an engine `received` time, `persisted: true`, a dispatched state, `responseClosed` recorded and `responseFinished` null

#### Scenario: Engine never received the create

- **WHEN** the diagnostic is formatted for an outcome with no engine create receipt
- **THEN** the engine `received` field is null and `persisted` is false, with the child timing and requests still reported

#### Scenario: Successful and stalling runs are unaffected

- **WHEN** the create succeeds, or the stalling case is cancelled as designed
- **THEN** child stderr stays empty and stdout, requests and cleanup assertions are unchanged

### Requirement: Unresolved submissions identify their operation and test without sensitive detail

Every shared-Engine submission published by the test process's Docker CLI wrapper or the tracked Engine HTTP client's default submission SHALL record, in its journal `submitted` row, a `call` label made only of a transport (`cli` or `http`), an operation from a fixed vocabulary (a CLI verb and known group subcommand, or an HTTP method with an endpoint template whose resource segments are `{id}`; otherwise `other`), and a caller basename taken, in order, from the issuing `*.test.ts` file under `platform/test/` on the call-time stack, else (for the tracked client) at its construction point; else the first non-wrapper `platform/test/` module on the call-time stack, else (for the tracked client) at its construction point; otherwise `unknown`. Deployed-observer per-request records SHALL remain limited to opaque correlation identities and fixed states. The label SHALL NOT contain arguments, resource names or identifiers, query strings, paths, environment values or credentials. The journal parser SHALL accept rows with a valid label and rows written before the label existed, and SHALL reject any other label shape. Settlement and cleanup verdicts SHALL be unchanged.

#### Scenario: An unresolved HTTP mutation is attributable

- **WHEN** a test's tracked Engine client submits `POST /containers/<id>/kill` and the request fails outside the qualified rejection matrix
- **THEN** the submission stays unresolved, custody cleanup stays unconfirmed, and its `submitted` row names `http`, `POST /containers/{id}/kill` and the issuing test file

#### Scenario: Labels never carry sensitive detail

- **WHEN** a CLI or HTTP mutation includes resource names, IDs, query parameters or arbitrary arguments
- **THEN** the recorded label contains only the fixed-vocabulary operation and the caller basename (or `unknown`)

#### Scenario: Older journals remain readable

- **WHEN** custody assesses a journal whose rows predate the label
- **THEN** the assessment is identical to before, and a row with a malformed label is rejected as malformed evidence
