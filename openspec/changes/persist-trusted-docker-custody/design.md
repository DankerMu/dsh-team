# Design

## Context

See proposal.md for motivation. The existing full root command already owns browser provisioning, canonical rescue and original Vitest discovery. Its final exit includes those checks, but SSH currently carries the only complete output/verdict. The model lane's detached-owner pattern, atomic receipt writer and process-birth helpers exist; its authorization, secret handling and worker command are not reusable as a Docker lane.

An owned Linux experiment using pinned real pnpm showed that signalling only pnpm did not settle its child. A separate session/group with birth-checked group SIGINT reached the literal child. This is process-primitive evidence only: it does not establish Docker mutation settlement or safe acquisition cleanup.

## Goals / Non-Goals

The governing invariant is one reviewed invocation, one durable owner and an honest terminal outcome: observer loss cannot manufacture completion, and successful cleanup cannot turn command failure into acceptance.

Non-goals: automatic provider calls, GitHub status publication, restricted-model owner changes, image/proxy policy changes, new global execution deadlines, deadline increases, retries, test selection changes, global/PID-prefix rescue, general host watchdog or automatic recovery after unknown owner death. The trusted parent still performs independent host/resource verification before attestation.

## Decisions

### Narrow independent owner rather than a second model service

Use a remote POSIX detached Node owner with private stdio, following the existing detached-owner pattern without its model authorization. The root command exposes start, status, logs and explicit cancel operations. The prepared dedicated checkout must match the supplied full reviewed SHA and remain frozen; the owner records its canonical root identity and rechecks admission before work. Start does not install dependencies, build unrelated artifacts or fetch a different revision.

The owner has its own session; the original `pnpm test:docker` child has a separate owned session/group. SSH clients only observe. Qualification must actually disconnect SSH while the child is live and then reconnect to the same owner/result on giap-vps. No silent fallback is permitted if that host cannot sustain the detached owner. A transient-service topology was considered but adds service/environment custody without being required by this SSH-disconnection contract; extending the model owner would violate the lane boundary.

### Publish authority before work

Create a unique private invocation directory and intent, then publish the owner's PID plus canonical birth identity, reviewed SHA, exact argv and canonical checkout identity before spawning test work. Capture the child identity separately. UUID-only public operations resolve within the fixed private custody root; validate file type, ownership, permissions, bounds and matching identities. Reuse the atomic receipt writer, but not its browser-specific reader for unrelated schemas. A dead owner without a valid terminal receipt is unknown, never completed or available for PID-only takeover.

Use an invocation-owned short temporary root and private Docker configuration, with the existing pre-create resource journal. Keep launch records, output and terminal receipts outside writable browser profiles. Do not persist environment values. No CI/model invocation marker is introduced for ordinary Docker work.

### Safe complete output without whole-run buffering

Capture stdout and stderr incrementally into separate private files, preserving each stream's order and backpressure. Explicitly allow only required runtime/tool fields and existing ordinary proxy inputs into the test environment; never inherit provider/GitHub/SSH credentials. Preserve proxy strings at the existing Docker boundary, but exclude their values and credential components from durable output even across chunk boundaries. Existing inner command output bounds remain unchanged. Output loss or write failure is explicit and prevents acceptance; it is not a truncated successful transcript. Final receipts bind completed logs by byte count and digest.

### Cancellation is an owned transition, not observer timeout

A validated cancel operation publishes an invocation/owner-bound request; the owner alone signals its captured child group after fresh birth/identity checks. Observing-client loss does not create that request. Never assume a signal to pnpm alone forwards to its descendants. If the child identity changed or work is already terminal, do not signal a guessed group. Preserve original command exit/signal independently from the cancellation request.

Group interruption can leave daemon-side creation uncertain. Settle the actual command and its owned process scope before cleanup assessment; canonical browser producer/receipt uncertainty remains authoritative. Unknown work or identity means unconfirmed cleanup and retained evidence, not broad rescue. The owner does not add a second Docker deletion implementation or kill unrelated processes to make cleanup pass.

### Separate command, evidence and cleanup outcomes

The recorded command result is the original root command's actual exit/signal, not an invented independent Vitest verdict. Record interruption and output completeness separately. Assess registered Docker targets and browser/image receipts through existing exact-absence/identity contracts after process settlement; discovery never grants deletion authority. Existing root-command cleanup remains the mutation owner. Missing/malformed authority, surviving work or resources is unconfirmed cleanup. Command failure plus observed cleanup remains failure; command success with incomplete output or cleanup is not acceptance.

Retain private evidence needed for reconnect and diagnosis, including failures. The parent independently confirms owned retirement and unchanged daemon/bridge/unrelated workloads before any GitHub success status.

## Verification and Delivery

Use real owned Node/pnpm subprocess fixtures behind external process boundaries, not mocks of custody logic. Trace one behavioral RED/GREEN slice at a time: durable output, launch/status, disconnect, cancellation and identity refusal, then cleanup/evidence failures. Tests must preserve nonzero results, prove no secret canary persistence and preserve an unrelated live sentinel. Real giap-vps qualification disconnects an observer during live work, reconnects by UUID, and runs the delivered entrypoint through the original complete Docker suite. Standalone Compose and independent cleanup/host fences remain separate required evidence.

## Risks / Trade-offs

- Detached process survival depends on the qualified host's session policy; real SSH-disconnection evidence is required, and missing owner/final evidence fails closed.
- PID reuse or child-group loss must not authorize signalling; require captured birth and invocation ownership, and refuse uncertain identity.
- Full logs consume disk; streaming/backpressure avoids memory growth, while write failure invalidates evidence instead of silently dropping output.
- Canonical root cleanup can remain unconfirmed after interrupted creation; preserve that failure and authority rather than inventing rescue guarantees.
- A frozen checkout is an operator precondition, not a defence against a malicious same-UID operator rewriting the reviewed tree during execution.

## Migration and Containment

Document the delivered custody command as the ordinary trusted full-Docker remote entrypoint, retaining the original test command as its unchanged child. No existing running job is adopted. Roll back through a reviewed source revert only when no invocation is active; keep private records for any outstanding/unknown owner. Do not remove custody files or release ownership merely because an observing client ended.
