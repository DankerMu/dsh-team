# Tasks

## 1. HTTP policy and compatibility

- [x] 1.1 Add real HTTP typo regression, observe200→expected400 RED, enforce only entry-key policy at the write boundary, and prove unchanged complete settings/audit rows with no secret echoes.
- [x] 1.2 Cover later/mixed/prototype-like unknown keys and existing malformed/value-domain cases; prove valid contextWindow persistence and legacy stored-extra-field read projection without rewrite. Update existing API documentation.

## 2. Integration and release

- [x] 2.1 Run focused integration, ordinary unit coverage, fast/build/contract checks; exercise source/dist real HTTP/file-database reopen, and retain proof that shared parser and generated contract remain unchanged.
- [ ] 2.2 Complete independent cross-review, exact-head trusted Compose/full Docker and required CI; merge and archive after acceptance.

## Risk packs

- Selected Public API / CLI / script entry:1.1,1.2; HTTP only, no CLI change.
- Selected Schema / columns / units / field names:1.1,2.1; existing schema allowlist and generator-only contract handling.
- Selected Auth / permissions / secrets:1.1,2.1; preserve existing authorization, secret custody and rollback regressions.
- Selected Legacy compatibility / examples:1.2; historical stored-extra-field read without rewrite.
- Selected Error handling / rollback / partial outputs:1.1; complete settings/audit equality on400.
- Selected Documentation / migration notes:1.2; explicit strict HTTP policy and unchanged storage compatibility.
- Not selected Config / project setup, File IO / path safety / overwrite, Concurrency / shared state / ordering, Resource limits / large input / discovery, Release / packaging / dependency compatibility: no new configuration, writer, concurrency mechanism, limit, package or dependency; existing process/storage release gates retained in2.1/2.2.
