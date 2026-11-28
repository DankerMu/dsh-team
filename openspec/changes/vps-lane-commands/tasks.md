## Risk packs

- **Public API / CLI / script entry (selected).** New package scripts `lane:vps` and `lane:vps:post`. Tasks 1.1, 1.2.
- **Config (selected).** Toolchain paths come from the repository pins; a missing pin or missing host toolchain fails loudly. Task 1.1 tests.
- **File IO (selected).** Outputs only under `.run/vps-lane/<label>/`; a failed run clears its own build directory; nothing is written outside it locally. Task 1.1 tests.
- **Auth / permissions / secrets (selected).** Publishing the GitHub status, plus the docker-proxy fields that stay on the host. Tasks 1.1, 1.2 tests.
- **Error handling / partial outputs (selected).** Transient SSH, unreachable status, failed build, partial summary. Tasks 1.1, 1.2 tests.
- **Concurrency / shared state (selected).** Label reuse refusal and per-run remote staging. Task 1.1 tests.
- **Documentation (selected).** `scripts/README.md` section and the AGENTS.md line. Task 1.3.
- **Not selected:**
  - Schema: no HTTP route or persisted schema.
  - Resource limits: image tars are streamed by scp as today.
  - Legacy compatibility: no existing command changes.
  - Release: no dependency change.

## Must preserve

- Custody's contract and sole cleanup ownership. The CI workflows and the evidence gate are unchanged.
- The trusted-host rule: only the trusted parent session runs these commands (AGENTS.md Environment).

## 1. Implementation

- [x] 1.1 `lane:vps` with `platform/test/vps-lane.integration.test.ts` covering the design's run-side required evidence, red first.
- [x] 1.2 `lane:vps:post` with the post-side required evidence in the same test file, red first.
- [x] 1.3 Docs: a `scripts/README.md` § Parent-side VPS lane section (usage, evidence files, pass criteria, boundaries); one AGENTS.md Daily-commands line; AGENTS.md stays within its 320-line budget.

## 2. Verification

- [ ] 2.1 `pnpm lint:shell`, `pnpm lint:agents`, `pnpm check:fast` and `pnpm test:integration` exit 0 locally.
- [ ] 2.2 One real `pnpm lane:vps` run on this PR's exact head passes, and `pnpm lane:vps:post` writes this PR's Runtime evidence.
- [ ] 2.3 The PR carries `diff-limit-exempt` with a justification if it exceeds 400 changed lines.
