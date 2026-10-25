## MODIFIED Requirements

### Requirement: Explicit cancellation preserves exact ownership and uncertainty

Only an explicit matching invocation cancellation request SHALL authorize the owner to signal its captured work after fresh identity checks. The owner SHALL settle submitted work before claiming cleanup and SHALL preserve canonical browser acquisition and Docker ownership rules. After the owner itself signalled its captured group, and only once that group, its producers and browser producers have settled, no submission writer remains live other than a registration's own exactly bound deployment platform, and the invocation identity is unchanged, the owner SHALL retire the resources registered in that invocation's private journal: exact registered names and labels only, latest registration first. A registration that includes the fixed deployment platform SHALL be retired only while holding the host-wide deployment lock and only after that platform has been drained by SIGTERM to a confirmed clean exit and every submission reservation has then settled; if the lock is unavailable, the drain is unconfirmed or settlement remains pending, nothing of that registration SHALL be removed. The read-only cleanup assessment SHALL still alone decide confirmed or unconfirmed cleanup, and a cancelled run SHALL never be reported as passed. PID-only signalling, prefix/global rescue, foreign-resource deletion and uncertain-creation cleanup claims SHALL remain forbidden.

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
