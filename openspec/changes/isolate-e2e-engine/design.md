# Design

## Context

See proposal.md for the race. The smoke inventory is health.hurl and login.hurl: only health, built login HTML/assets and platform404 requests. Main awaits real reconciliation before listening. A fresh private Engine therefore needs no image import, employee network or port publication. Store/process isolation alone proved insufficient: the installed daemon deletes `docker0` on `--bridge=none` in whichever network namespace it occupies. Full acceptance exposed that shared-kernel effect after narrower employee-bridge tests passed.

## Goals / Non-Goals

Governing invariant: no e2e invocation observes or mutates Docker objects or kernel network state outside its captured private runtime.
Must preserve: real built main, awaited reconciliation, fresh SQLite schema and migration versions1/2, complete hurl suite, nonroot application, owned process/data cleanup and command failure propagation.
Non-goals: production lifecycle changes, dev-server isolation, image seeding, employee startup in e2e, address-pool leasing, provider calls, host daemon configuration or generic supervision infrastructure.

## Decisions

1. Use installed dockerd plus an explicitly separate containerd, not merely a different dockerd data-root. Give both invocation-private config/root/state/socket paths and container/plugin namespaces. Verify actual Engine info before scenario admission. Ignore inherited Engine selection; the scenario receives only the captured socket.
2. Disable default bridge, IPv4/IPv6 iptables, forwarding and masquerading, but never treat those flags as kernel isolation. Both daemons must run in a fresh network namespace; the supervisor rejects unchanged caller namespace identity before any network/daemon mutation and verifies both live daemon memberships before scenario admission.
3. A nonroot command wrapper owns a pipe to a fixed checked-in Python supervisor. Run the supervisor as PID1 inside fresh PID/mount/network namespaces through noninteractive sudo and util-linux unshare with kill-child. Enable only that namespace's loopback. Build, main and the HTTP smoke client run there together; no external route or image pull is needed. Stdin EOF handles invoking-parent loss; namespace-init death contains daemon descendants. Explicit signal handlers are required for PID1. No installed service or persistent unit.
4. The supervisor captures two fresh0700 directories: privileged state stays root-only, and only the separate socket/temp directory is chowned to the original caller. It owns actual child handles and stops the scenario before dockerd before containerd. Await real closure; bounded escalation is failure evidence, not graceful success. Both captured paths are removable only after owned processes settle. Retain private diagnostics on unconfirmed cleanup; no caller-supplied path adoption or shared socket permission changes.
5. Run build and application as the original nonroot UID/GID, with a minimal explicit environment and no ambient secrets. The privileged worker never executes caller-selected scenario commands. Keep the existing e2e scenario as one implementation reached through the owner, not an environment-flag bypass to shared main.
6. Use the existing real DockerClient wrapper in the Docker fixture to hold the outer owner's canonical container-create call after its real bridge creation. Run actual pnpm e2e concurrently on its private Engine, independently inspect the original bridge, then release and require original readiness. No raw relay or CLI shim is needed for this injectable client seam.
7. Prove kernel noninterference independently: a test-owned caller-network `docker0` sentinel survives actual e2e and retirement with unchanged link identity, and both observed daemon namespace identities differ from the caller. The real-host public-command case also checks the actual default bridge before/after; missing network isolation must refuse before daemon launch. A deliberate RED runs only in a disposable outer network namespace, never against the shared host.
8. Negative fault qualification has its own outer network namespace, independently checked against the real caller before admission. Omitting the inner namespace tests the production refusal only inside that disposable boundary. Mode-specific event barriers hold the worker at the actual selected guard/injection, allowing the parent to capture real runtime process identities before release. Expected rejection requires the selected phase and allowed side-effect trace, not merely any nonzero exit. Unrelated early exceptions remain unqualified; forbidden early network/daemon attempts fail without forwarding. Process-tree observation accepts a disappearing transient only after independently rechecking that its captured birth identity is absent, dead or replaced. Later daemon checks reuse the birth-fenced executable snapshot instead of reopening transient command lines; both actual daemon identities and private namespace memberships must still hold.

## Risks / Trade-offs

- Linux/sudo prerequisite narrows local e2e availability; document explicit refusal and use trusted Linux CI/VPS. Local check/test commands remain unchanged.
- Root verification code is security-sensitive; review all argument, environment and cleanup authority paths. This is trusted checkout execution, not a privileged service offered to untrusted users.
- Namespace flags alone do not prove containment; qualify actual namespace identities, parent EOF, supervisor death, partial start and normal cleanup with independently captured process/root identities. A local loopback URL printed by e2e belongs to its private namespace, not a host-facing listener.
- Future smoke that starts instances would require additional network/image qualification; the current evidence makes no such claim.

## Migration Plan

Replace the public e2e entry atomically, retaining one scenario implementation. Verify absence-of-prerequisite refusal before production main and shared mutation. Keep CI's dev-server Engine setup unchanged unless a concrete prerequisite adjustment is required. Rollback is a reviewed git revert, not a shared-Engine fallback.
