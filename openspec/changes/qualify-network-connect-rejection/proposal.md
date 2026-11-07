# Settle a definitive network-connect validation rejection

## Why

Fixture #426 requires a real-Docker case in which the orchestrator's +4 Document Server connect is refused. The stand-in shares another container's network namespace, so Docker answers `POST /networks/<id>/connect` with 400 (`ErrConflictSharedNetwork`). On PR #548 at d7a2754 every test passed (37 files / 129 tests), but custody stayed `unconfirmed`. Its projection was one unsettled `POST /networks/{id}/connect` from `container-document-server.docker.test.ts`. The tracked Engine client settles only the qualified rejection matrix: network-create 403, stop 304 and exact DELETE 404. A deliberately provoked, definitive connect rejection therefore can never reach confirmed cleanup (#549).

## What Changes

- The qualified rejection matrix gains exactly one entry: `POST /networks/<target>/connect` with 400. A connect 400 is a definitive Docker reply to request or configuration validation (this case: `ErrConflictSharedNetwork`); a partially created endpoint is Docker's to roll back. Independent resource-state checks remain the backstop: a leftover endpoint on an owned network makes the network delete answer outside the matrix, which keeps cleanup unconfirmed. The orchestrator already treats any `DockerHttpError` from connect as a definitive reply and inspects membership independently (`platform/src/orchestrator/networks.ts`), so this entry is narrower than production.
- Every other connect status, a lost response, noncanonical error provenance, and a 400 on any sibling endpoint stay unresolved.
- Files: `scripts/verification-submissions.mjs` `isDefinitiveRejection`; the matrix cases in `platform/test/docker-client.integration.test.ts`; the `trusted-docker-verification` spec scenario.

## Triage

```text
Issue type: gate semantics (custody settlement), user-decided 2026-11-06
Fixture level: compact
Blast radius: a too-broad entry would settle a connect whose endpoint exists; the entry is one method, one endpoint template, one status
Selected risk packs: Concurrency/verification evidence (settlement classification)
Evidence floor: integration matrix cases (settle 400; 403/404/409/500 and disconnect 400 unresolved); pnpm check; VPS exact-head test:docker + test:deploy confirmed; #548 rebased exact-head test:docker cleanup confirmed
```
