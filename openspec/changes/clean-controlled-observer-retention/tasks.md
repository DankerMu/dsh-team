## 1. Controlled observer root retirement

- [ ] 1.1 Docker-free RED regression in new `platform/test/deployment-observer-fixture.integration.test.ts` for `removeRetiredObservationRoot` with real private directories (temporary prefix not `/tmp/dsh-team-observer-`; identity compared to `rootIdentity`, no hardcoded uid): retired owned 0700 root removed; `ownedRoot=false` no-op; unretired, replaced inode, wrong mode, symlink and non-directory roots refused and left in place.
- [ ] 1.2 Extract the function from `finishDeploymentObservation`'s success branch (single implementation, unchanged error wrapping); GREEN.
- [ ] 1.3 Failure-path drain regression removes its captured root after its `finally` cleanup only when `failures` is empty; audit-stop wraps `start` to capture into `control` (reset in `beforeEach`) and removes only in the overdue case after its assertions. Missing captured observations fail; removal errors aggregate; any failure retains the root.

## 2. Integration

- [ ] 2.1 Canonical checks, review, exact-head trusted custody `pnpm test:docker` (custody no-op path) and standalone `pnpm test:deploy`, plus a direct non-custody `pnpm test:docker platform/test/deployment-audit-stop.docker.test.ts`, each standalone/direct run with `/tmp/dsh-team-observer-*` inventory unchanged; independent resource observation; protected merge.

## Risk packs

- Selected: file IO/path safety → 1.1/1.2; captured identity fence, no discovery, no prefix deletion.
- Selected: error handling/partial outputs → 1.3; removal only after passing assertions, errors aggregated, genuine-failure retention unchanged.
- Not selected: public API/CLI, config, schema, auth/secrets, concurrency, resource limits, compatibility, packaging, documentation — no change to those surfaces.
