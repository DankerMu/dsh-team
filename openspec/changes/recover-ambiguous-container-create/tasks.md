# Tasks

## 1. Durable provenance

- [x] 1.1 Reproduce both no-row false-retirement windows over real Unix HTTP/file SQLite and record the user's cross-restart policy; evidence in `.run/issue192/red-socket-and-inspection.log` and `decision.json`.
- [x] 1.2 Add migration3 for one nonsecret attempt per user; prove repeated migration, historical-row preservation, constraints, file reopen and updated source/dist ledger consumers. The observed pre-change unit run fails on the absent attempt table with2246 other tests passing.

## 2. Identity-bound recovery

- [x] 2.1 Persist attempt before final create, retain learned identity and consume atomically with instance/audit commit; prove failure rollback, no credentials in durable provenance, and both existing wire RED cases through the chosen recovery behavior.
- [ ] 2.2 Implement one never-started exact-attempt recovery path for explicit start/stop and fresh-owner reconciliation; prove nonce/ID/image/account/row/mount/network fences, no name-only adoption, known-ID partial-cleanup resumption, unknown absence quarantine and retained volume bytes.
- [x] 2.3 Integrate durable status/routing exclusion and current-authority stop/disable/enable semantics; prove deadline, transport, service cancellation, FIFO/shutdown and sibling preservation through the existing real-wire service/HTTP seams.
- [x] 2.4 Update existing deployment recovery guidance and migration documentation after source/dist file-database smoke proves restart recovery, no stale routing and no secret output.

## 3. Real consumer proof and delivery

- [ ] 3.1 Add real Engine fault injection around applied create and inspection; independent exact-ID observation, reconstructed owner/file database, production recovery/retry, original home/work sentinels and sibling snapshots pass in both upstream modes under root `pnpm test:docker`.
- [ ] 3.2 Run canonical local checks, four-seat review and exact-reviewed-head trusted standalone Compose plus original full Docker; retain independent cleanup/host-fence evidence, green protected CI, merge, sync/archive and observe main CI.

## Risk pack mapping

- Public API:2.3, unchanged endpoint shapes and safe error projection.
- Config/setup: not selected; no environment or host setup change.
- File IO/path safety:1.2/2.2/3.1, private SQLite and exact volume/overlay identities.
- Schema:1.2, additive migration and historical preservation.
- Auth/secrets:2.1/2.3, current account/session gates and no credential-bearing receipt.
- Concurrency/shared state:2.2/2.3, original FIFO and bounded submitted work.
- Resource discovery:2.2/3.1, receipt-backed exact identity only; no general orphan sweep.
- Legacy compatibility:1.2/2.2, old rows retained; no retrospective deletion authority.
- Error/rollback:2.1/2.2, partial physical success and transaction failure remain recoverable.
- Release/packaging:1.2/2.4/3.2, generated migration copy and source/dist/Compose proof.
- Documentation:2.4, operational quarantine and safe upgrade/rollback boundaries.
