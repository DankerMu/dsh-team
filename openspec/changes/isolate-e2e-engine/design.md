# Design

## Context

See proposal.md for the race. The smoke inventory is health.hurl and login.hurl: only health, built login HTML/assets and platform404 requests. Main awaits real reconciliation before listening. A fresh private Engine therefore needs no image import, employee network or port publication. Existing qualification proved separate Docker/containerd stores and namespaces, nonroot socket access, real bridge/container operations and system-runtime invisibility; that is not final implementation acceptance.

## Goals / Non-Goals

Governing invariant: no e2e invocation observes or mutates Docker objects outside its captured private Engine.
Must preserve: real built main, awaited reconciliation, fresh SQLite schema and migration versions1/2, complete hurl suite, nonroot application, owned process/data cleanup and command failure propagation.
Non-goals: production lifecycle changes, dev-server isolation, image seeding, employee startup in e2e, address-pool leasing, provider calls, host daemon configuration or generic supervision infrastructure.

## Decisions

1. Use installed dockerd plus an explicitly separate containerd, not merely a different dockerd data-root. Give both invocation-private config/root/state/socket paths and container/plugin namespaces. Verify actual Engine info before scenario admission. Ignore inherited Engine selection; the scenario receives only the captured socket.
2. Disable default bridge, IPv4/IPv6 iptables, forwarding and masquerading. The current scenario creates no networks or published ports. Do not introduce subnet allocation or shared-image reads for capabilities the scenario does not use.
3. A nonroot command wrapper owns a pipe to a fixed checked-in Python supervisor. Run the supervisor as PID1 inside a fresh PID/mount namespace through noninteractive sudo and util-linux unshare with kill-child. Stdin EOF handles invoking-parent loss; namespace-init death contains daemon descendants. Explicit signal handlers are required for PID1. No installed service or persistent unit.
4. The supervisor owns actual child handles and stops the scenario before dockerd before containerd. Await real closure; bounded escalation is failure evidence, not graceful success. Only captured invocation paths are removable after owned processes settle. Retain private diagnostics on unconfirmed cleanup; no PID-only external adoption or shared socket permission changes.
5. Run build and application as the original nonroot UID/GID, with a minimal explicit environment and no ambient secrets. The privileged worker never executes caller-selected scenario commands. Keep the existing e2e scenario as one implementation reached through the owner, not an environment-flag bypass to shared main.
6. Use the existing real DockerClient wrapper in the Docker fixture to hold the outer owner's canonical container-create call after its real bridge creation. Run actual pnpm e2e concurrently on its private Engine, independently inspect the original bridge, then release and require original readiness. No raw relay or CLI shim is needed for this injectable client seam.

## Risks / Trade-offs

- Linux/sudo prerequisite narrows local e2e availability; document explicit refusal and use trusted Linux CI/VPS. Local check/test commands remain unchanged.
- Root verification code is security-sensitive; review all argument, environment and cleanup authority paths. This is trusted checkout execution, not a privileged service offered to untrusted users.
- Namespace flags alone do not prove containment; qualify actual parent EOF, supervisor death, partial start and normal cleanup with independently captured process/root identities.
- Future smoke that starts instances would require additional network/image qualification; the current evidence makes no such claim.

## Migration Plan

Replace the public e2e entry atomically, retaining one scenario implementation. Verify absence-of-prerequisite refusal before production main and shared mutation. Keep CI's dev-server Engine setup unchanged unless a concrete prerequisite adjustment is required. Rollback is a reviewed git revert, not a shared-Engine fallback.
