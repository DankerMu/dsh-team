## 1. Diagnostics grammar

- [x] 1.1 In `platform/test/docker-build-diagnostics.integration.test.ts` add cases for `[stage-0  2/11] RUN`, `[build  2/10] RUN` and padded unknown stage `[private-stage  1/1]`; observe RED on current main, then widen `lastBuildHeader` in `scripts/docker-build-diagnostics.mjs` (stage `build|runtime|stage-0`, ` +` before `i/N`) and observe GREEN with all existing cases unchanged.

## 2. Restricted worker selection

- [x] 2.1 Extend `platform/test/ci-vps-worker-fixture.ts` with a staging option (approved-SHA mapping, other-SHA mapping, symlink, `verification-images` as a regular file, inherited/env-file canaries) and a per-call `DSH_TEAM_VERIFICATION_IMAGES` projection in `parseCalls`. Add regressions: staged `<approved-sha>.json` ⇒ only the driver `pnpm test:model` call has exactly that path, git/install/build calls and phase/execution/final receipts do not; other-SHA or absent with canaries ⇒ no variable in the driver call; symlinked `<sha>.json` ⇒ path passed unresolved; ENOTDIR ⇒ `phase.json` `{phase:'driver',state:'failed',category:'unknown'}`, `execution.json` `{exitCode:1,phase:'driver',category:'unknown'}`, no `pnpm test:model` call. Observe RED first.
- [x] 2.2 Implement in `platform/test/ci-vps-worker.ts`: after `enter('driver')`, reuse `exists()` for the presence check (absent ⇒ unset; other errors throw and are recorded as driver/unknown), export only into the driver spawn environment, add the name to the inline driver allowlist (copied before `loadEnvFile`). No other environment or receipt changes.

## 3. Documentation

- [x] 3.1 Update AGENTS.md trusted local-build/upload and restricted model paragraphs: SHA-named host-local mapping with all three roles, operator build/transfer/private-permission/frozen-lifetime/removal duties, confirm the exact host `<sha>.json` exists before `pnpm ci:model` (missing/misnamed ⇒ native, accepted residual risk), SHA name binds selection not provenance, and uploaded runs do not exercise registry/Buildx transport for those images. Check `pnpm lint:agents` and formatting.

## 4. Integration and acceptance

- [x] 4.1 Canonical checks, expanded review, CI, trusted exact-head `test:docker`/`test:deploy` custody evidence and merge.
- [ ] 4.2 After merge, obtain separate SHA-bound authorization for exactly one `pnpm ci:model` run with staged final-SHA layouts; record original model acceptance and independent cleanup. Not part of this change's completion; no retry. Tracked by #319.

## Risk mapping

- Selected: Config / project setup → 2.1–2.2, 3.1; one fixed SHA-named host-local path, absence preserves native.
- Selected: File IO / path safety → 2.1–2.2; worker only `lstat`s, never follows or reads; the adapter's existing O_NOFOLLOW/0600/same-uid/nlink checks validate content.
- Selected: Auth / permissions / secrets → 2.1; the path reaches only the driver child; never install/build/git/SSH/GitHub/receipts.
- Selected: Error handling / partial outputs → 2.1–2.2; non-ENOENT presence failure fails the driver phase before spawn; invalid selection fails closed in the adapter, no native fallback.
- Selected: Legacy compatibility → 1.1, 2.1; existing header projections and native worker behavior unchanged.
- Selected: Documentation → 3.1.
- Not selected: Public API / CLI / script entry (worker argv and modes unchanged; only one driver-child environment field added). Schema / receipts: worker receipts unchanged; `lastObservedBuildHeader.phase` gains the value `'stage-0'` in `image.json` failure and `docker-command.ts` diagnostics, but no consumer validates it as a closed set (`rescueBrowserImage` reads only `tag`/`imageId`). Concurrency (single one-shot worker); Resource limits (adapter bounds unchanged); Release / packaging (no dependency change; the worker is installed per invocation from the reviewed SHA tree).
