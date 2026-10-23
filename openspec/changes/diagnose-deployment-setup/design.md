# Design

## Context

See proposal.md for motivation. `verifyDeployedCredentialPrivacy` keeps phase=`setup` across `withDeployment` and `configureDeployment`, then discards the caught exception. That safely prevents credential leakage but conflates lock/user-image preparation, fixed-name admission, platform build, local files, Compose startup, health, administrator PTY/login, model configuration and employee registration. The observed timeout envelope never started; its zero elapsed time is not evidence of a stop deadline defect.

`withDeployment` already owns fixed-name exclusion and drainage. `runUserImage` owns image/volume cleanup. `configureDeployment` owns real health/PTY/HTTP setup. Diagnostics must sit at those existing owners rather than duplicate commands or infer phases by parsing errors.

## Goals / Non-Goals

Goals: identify actual entered/completed boundaries; preserve the first failure and independent cleanup classification; prove fixed-field secrecy before trusted diagnosis; keep current acceptance behavior intact.

Non-goals: recover unrecorded historical exceptions, claim the new observation is a root-cause fix, retain raw errors, change production behavior or model execution, change timeouts/retries/host configuration, or add a general logging framework. Issue274 process/mutation settlement remains a separate change and review gate.

## Decisions

### One bounded progress implementation at existing operation owners

Reuse an existing suitable safe progress implementation if present; otherwise introduce one verification-local typed progress owner, not copies in each fixture. Its closed phase vocabulary follows the real setup sequence: deployment admission, user-image preparation, fixed-name check, Compose capability, resource registration, platform build/identity, local configuration, scenario preparation, Compose creation, health, administrator terminal/login, model configuration and employee registration. Track entered and last-completed boundaries separately, and latch the first failure before cleanup can change current progress.

Pass an optional owned progress context through existing setup callers. Observation does not replace their commands or alter execution. Migrate wrappers that forward those calls so no selected consumer silently drops the context. Ordinary callers without the observer keep their current behavior; there is no second setup implementation.

Nested progress follows operation ownership: the deepest entered but unfinished operation is current, a completed child does not complete its parent, and the last-completed fact changes only after that operation actually returns successfully. On rejection, latch the deepest failing boundary before unwinding; outer catches and later cleanup cannot overwrite it. Track cleanup in a separate bounded outcome rather than reusing the setup phase.

### Closed projection rather than raw-error redaction

Emit only explicitly constructed bounded facts: known phase values, entered/completed status, fixed failure category and independent cleanup classification. Never copy arbitrary error properties, messages, causes, stacks, Docker output, paths, input values or environments. Unknown lower-level cause stays `unknown`; phase labels mean only which operation had not completed.

The privacy fixture retains its sanitized rejection and original rejection behavior. The observation must preserve a primary setup failure when drainage also rejects; successful cleanup cannot turn that failure into acceptance. Where an existing cleanup boundary cannot prove completion, the projection says unconfirmed rather than inferring success. No diagnostic record becomes signal or deletion authority.

Evidence loss is explicit and independent: a sink/retention failure must not replace the original primary failure or create setup/cleanup success. Preserve the safe first-failure projection in the returned failure where possible and mark evidence unavailable; if no durable channel is available, report that limitation rather than claiming retained evidence. Cleanup completion comes only from the existing lifecycle owner's actual result, never an observer callback, an exhausted finally block or a new empty-inventory rule. This change does not redefine issue274 settlement.

### Evidence-first investigation, no green-by-retry

First qualify controlled failures at genuine fixture/dependency boundaries with distinctive secret canaries and independent primary/cleanup outcomes. Permanent regressions cover consumer-visible evidence, not copied phase strings or mock forwarding. An outside-test-runner smoke exercises the delivered observer path. Only then run bounded trusted diagnosis on a frozen reviewed candidate through existing root commands. A real recurrence is investigated at the earliest observed boundary; no speculative production fix or automatic repeat is permitted.

A reproduced cause outside these verification-only boundaries requires explicit scope reconciliation before repair; this fixture does not authorize a production, image, proxy, deadline or model-lane change merely because it was observed here.

## Risks / Trade-offs

- More phase boundaries add verification-only maintenance. Keep one typed vocabulary and label stable operations, not incidental internal statements.
- Sanitization intentionally loses raw causal data. Fixed reason codes cannot claim more than the observed boundary; retained UNKNOWN is preferable to leaking secrets or inventing cause.
- Cleanup has multiple owners. Preserve their actual outcomes rather than reducing an aggregate to whichever error occurred last.
- The owners are deployment drainage, invocation resource cleanup and, since #274, deployment observation retirement (`finishDeploymentObservation`). Observation retirement is classified from its own actual result like the others: `not-required` when no observation was created, `confirmed` only after it returns, otherwise `unconfirmed`; it is never inferred from drainage or resource cleanup.
- Instrumentation can affect timing. A later success qualifies the new candidate only, not historical attribution.

## Verification and Delivery

Expanded four-seat review and strict OpenSpec validation. Behavioral RED/GREEN for setup discrimination, canary secrecy and primary-plus-cleanup preservation; existing privacy/audit-stop assertions remain intact. Current-head local checks and full integration, actual trusted standalone Compose and original complete Docker discovery including both stop cases, and independent owned-resource/host-fence observations precede attestation and protected merge. Human acceptance remains explicitly deferred/unpassed. Archive only after delivery; retain failed candidates separately.
