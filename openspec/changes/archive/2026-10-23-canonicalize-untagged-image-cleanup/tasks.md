## 1. Canonical untagged image cleanup

- [x] 1.1 In new `platform/test/docker-cleanup.integration.test.ts`, add RED regressions for `removeOwned` image retirement using the exact Docker29 `No such image: <name>:latest` diagnostic: never-created and post-removal recheck succeed; an existing untagged owned image's label inspect, `rm` and post-removal inspect argv all use `<name>:latest`; tagged/ID targets unchanged; foreign reference, non-1 exit and label mismatch still fail.
- [x] 1.2 Extract `canonicalImageReference` beside `isAbsentResource`; use it in `removeOwned`'s image branch and replace the copies in `verification-image.mjs` and `trusted-docker-audit.mjs`. GREEN, with existing audit/admission tests unchanged.
- [x] 1.3 Library-level composite regression replaying `verification-image.mjs:159-165` (`registerCleanupTarget` untagged image → failed build → `cleanupTargets`): RED `failures.length === 1`, GREEN `0`; the CLI's `cleanup unconfirmed` depends only on nonempty failures and its build-failure exit is unchanged. No CLI injection seam.

## 2. Integration

- [x] 2.1 Canonical checks (`pnpm check:fast`, targeted integration, dead-code, duplicate-code), review, exact-head trusted Docker/Compose (tagged/ID no-regression only) with independent resource observation, protected merge. Real-Engine untagged evidence: issue reproduction plus fd27236 trusted custody.

## Risk packs

- Selected: error handling/partial outputs → 1.1/1.3; absence accepted only for the exact canonical reference, failures still aggregate.
- Selected: legacy compatibility → 1.1/1.2; tagged/ID behavior and audit/admission outcomes unchanged.
- Selected: release/packaging → 1.2; `trusted-docker-audit.mjs` and `verification-image.mjs` already import `docker-command.ts`, so standalone closures need no new file.
- Not selected: public API/CLI, config, file IO/path, schema, auth/secrets, concurrency, resource limits, documentation — no change to those surfaces.
