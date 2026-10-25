## Why

#345: in the ordinary trusted custody lane, `pnpm --silent verify:docker cancel` makes the owner send SIGINT to the child's whole process group (`scripts/trusted-docker-owner.mjs:163`). Vitest's fork workers share that group, have no SIGINT handler, and die immediately, and Vitest's main process exits about 1 ms later. Each Docker test's cleanup lives in that worker's `finally` (`deployment-fixture.ts:217-321`, `user-image-fixture.ts:408-410`), so none of it runs. The root wrapper only retires browser resources. The result is that journal-registered resources survive with no owner, and the read-only assessment correctly reports `cleanup: unconfirmed`.

This happened on 2026-10-25 (invocation `49e86e34`): a full deployment, including the fixed `dsh-team-platform`, two employee containers, networks, volumes and images, stayed running until the parent retired it by hand. A leftover fixed platform makes every later `test:deploy` and full Docker run refuse to start.

The user chose the direction: after a cancellation the custody owner itself retires exactly what this invocation's journal registered. The other options — in-band graceful abort, or documenting manual recovery only — were not chosen.

## What Changes

- When the owner itself signalled the child group (explicit cancel, owner signal, or capture failure), it retires the invocation journal's registered targets, using the existing canonical `readCleanupJournal` and `cleanupTargets` (`platform/test/docker-cleanup.ts`). It does this only after all of the following hold: the command group has settled, producers and browser producers have settled, no submission writer is still live, and identity and manifest are unchanged.
- A run that registered the fixed deployment platform (`dsh-team-platform`) is first drained under the host-wide deployment lock, using the same drain the deployment fixture already uses. The drain (SIGTERM by exact ID, `docker wait` exit 0, then `Running:false`, `ExitCode:0`, `OOMKilled:false`) is extracted into one shared implementation, so there is no second copy. If the drain or lock fails, that run is not touched. Other registered containers keep the existing canonical removal, because they do not drain on SIGTERM (`sleep infinity`, init-less `dsh`).
- The existing read-only `assessTrustedDockerCleanup` then decides `confirmed` or `unconfirmed`, exactly as today.
- A cancelled run stays `state: failed` and keeps `signal: SIGINT` and `interruption: cancelled`.
- Spec and AGENTS text: the custody owner gains this one retirement step. The assessment stays read-only. All prohibitions stay in place: PID-only signalling, prefix or global rescue, foreign-resource deletion, and claims about uncertain creation.

## Triage

```text
Issue type: bugfix
Fixture level: expanded (destructive Docker operations in the trusted custody lane; shared state; ordering after cancellation; spec ownership change)
Upstream suggested level: absent (issue says M, needs-triage; direction now decided by the user)
Blast radius: shared verification host; a wrong change could delete foreign or unregistered resources, force-remove a live platform owner, or report a cancelled run as clean/passing
Selected risk packs: Auth / permissions / secrets (deletion authority); Concurrency / shared state / ordering; Error handling / rollback / partial outputs; File IO / path safety (journal authority); Documentation
Evidence floor: new real-process custody regression RED→GREEN; existing trusted-docker custody/audit/output integration suites; pnpm check:fast; giap-vps real cancellation during the deployment test with independent host observation
```
