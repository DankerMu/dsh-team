# Tasks

## 1. Canonical authentication boundary

- [x] 1.1 Observe semantic RED for over-limit registration/login with unchanged SQLite rows, then enforce the normalized254-code-point bound; verify ASCII, astral, whitespace and lowercase-expansion boundaries plus administrator CLI rejection.
- [x] 1.2 Reuse one allocation-free code-point primitive and preserve password6..256/UTF-16LE behavior; run existing password and new boundary tests, and document the approved input contract.

## 2. Persistence and compatibility

- [x] 2.1 Observe audit-writer RED for each over-limit email field, implement pre-INSERT rejection, and prove unchanged metadata/NULL/empty semantics plus transaction rollback.
- [x] 2.2 Observe real source-entrypoint refusal RED against an incompatible file database; add a users-only startup guard before Docker/listening, prove source/dist refusal, NUL handling, disabled accounts and unchanged stored rows, and document offline remediation.
- [x] 2.3 Verify real HTTP historical audit browsing,254-astral exact filtering,255 rejection and no prefix matches; preserve historical rows and record unchanged query schema semantics.

## 3. Integration and release

- [x] 3.1 Run focused integration/CLI, unit coverage, fast checks, build and contract checks; retain a real HTTP/file-database smoke receipt and source/dist evidence.
- [x] 3.2 Complete independent risk-scaled cross-review, exact-head trusted Docker/Compose evidence and required CI; merge and archive only after all issue acceptance criteria pass.

## Risk packs

- Selected Public API / CLI / script entry:1.1,2.2,2.3.
- Selected Schema / columns / units / field names:1.2,2.1; code-point units, no migration or schema rewrite.
- Selected Auth / permissions / secrets:1.1,2.1; safe errors and unchanged authorization/password policy.
- Selected Resource limits / large input / discovery:1.1,2.1,2.2; early bounded counting and streaming account scan.
- Selected Legacy compatibility / examples:2.2,2.3; explicit startup refusal, historical audit preservation.
- Selected Error handling / rollback / partial outputs:2.1,2.2; transaction and process ownership evidence.
- Selected Release / packaging / dependency compatibility:2.2,3.1,3.2; source/dist parity and existing required release gates.
- Selected Documentation / migration notes:1.2,2.2; approved availability tradeoff and offline correction.
- Not selected Config / project setup: no environment or deployment configuration changes.
- Not selected File IO / path safety / overwrite: existing database ownership is reused, no new file format or writer.
- Not selected Concurrency / shared state / ordering: no new concurrency mechanism; existing transaction rollback is covered by2.1.
