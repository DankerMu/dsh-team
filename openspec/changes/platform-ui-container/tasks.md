## Risk packs

- **Config / project setup — selected.** Covers the job container, the digest pin and the version guard. Tasks 1.1 and 1.2.
- **Release / packaging / dependency compatibility — selected.** The image must track `@playwright/test`. The guard fails on drift. Tasks 1.2 and 2.1.
- **Resource limits — selected.** A roughly 0.96 GB image pull now runs inside the 10-minute budget. Measured in 2.2.
- **Not selected:**
  - Product code, auth, concurrency, file IO and schema are not touched.
  - Documentation / migration notes: task 1.3 is the only doc edit, specified in proposal § What Changes.

## Acceptance-criteria mapping (#667)

- **AC1** (no runtime apt fetch) → 1.1, 1.2, 2.2.
- **AC2** (`timeout-minutes: 10`, the assertions and the artifact upload are unchanged) → 1.1, 2.2.
- **AC3** (at least 5 executions, each with install-phase and job time; install under one minute) → 2.2. The install phase is `Initialize containers` plus the guard.
- **AC4** (the PR flags the workflow change) → PR body.

## Must preserve

- `runs-on: ubuntu-24.04`, `timeout-minutes: 10`, `needs: layer1-fast-checks` and the job `name`.
- `setup-node` with `node-version-file: .tool-versions` and `cache: pnpm`.
- `pnpm install --frozen-lockfile`.
- `run: pnpm test:ui`, verbatim.
- The SHA pins of `checkout`, `pnpm/action-setup`, `setup-node` and `upload-artifact`.
- The artifact step's `if: always()`, name, path, `include-hidden-files` and `if-no-files-found: error`.
- `package.json` `test:ui` and `test:ui:install`, and every local reference to `test:ui:install`: `AGENTS.md:116`, `docs/LOCAL_STACK.md:28`, `scripts/README.md:74`, and the hint text in `platform/test/test-stack.integration.test.ts:79` and `scripts/test-stack-prerequisites.mjs:118`.
- The `all-checks-passed` needs.
- `pnpm lint:ci` passes.

## 1. Implementation

- [x] 1.1 Add `container: image: mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27` to `platform-ui`.
  - Check that the existing steps work inside the container. These can only be proven by the CI runs in 2.2:
    - checkout, and husky `prepare`, running as root;
    - the pnpm store and its cache;
    - the artifact upload.
  - Check that `pnpm test:ui` runs Chromium from `/ms-playwright` without downloading it.
- [x] 1.2 Replace the `pnpm test:ui:install` step with a named inline guard step, as described in proposal § What Changes.
  - The step compares `@playwright/test` with the `driverVersion` in `/ms-playwright/.docker-info`.
  - A mismatch, a missing file or an unparsable file exits 1 and prints both versions and `dockerImageName`.
  - No `playwright install` call remains.
- [x] 1.3 Update `platform/web/README.md:11` as described in proposal § What Changes.

## 2. Verification

- [x] 2.1 Run `pnpm fmt:check` and `pnpm lint` (including `lint:ci`), then exercise the guard step locally.
  - Negative: run the step text inside another published image, `docker run --rm -v "$PWD:/w" -w /w mcr.microsoft.com/playwright:v1.62.0-noble bash -c '<step>'`, after `pnpm install`. Record the nonzero exit and both printed versions.
  - Missing record: run the step inside the pinned digest with `--tmpfs /ms-playwright` hiding the record. Record the nonzero exit and its message.
  - Unreadable record (optional): bind an empty file onto `/ms-playwright/.docker-info`.
  - Positive: run the same step inside the pinned digest and record exit 0.
- [ ] 2.2 Collect at least 5 `platform-ui` executions on this PR (reruns of the job). For each, record:
  - the `Initialize containers` seconds, the guard step's seconds and the job's seconds (install phase = the first two);
  - whether the pnpm cache hit or missed;
  - that no `archive.ubuntu.com` or `Fetched` line appears in the log;
  - that the screenshots artifact was uploaded.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
