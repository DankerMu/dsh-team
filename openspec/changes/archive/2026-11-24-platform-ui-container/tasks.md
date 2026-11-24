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
- **AC3** (at least 5 executions, each with install-phase and job time; install under one minute) → 2.2. The install phase is the guard step, which includes the image pull.
- **AC4** (the PR flags the workflow change) → PR body.

## Must preserve

- `runs-on: ubuntu-24.04`, `timeout-minutes: 10`, `needs: layer1-fast-checks` and the job `name`.
- `setup-node` with `node-version-file: .tool-versions` and `cache: pnpm`.
- `pnpm install --frozen-lockfile`, on the host.
- The `pnpm test:ui` command, verbatim, now run inside the image.
- The SHA pins of `checkout`, `pnpm/action-setup`, `setup-node` and `upload-artifact`.
- The artifact step's `if: always()`, name, path, `include-hidden-files` and `if-no-files-found: error`.
- `package.json` `test:ui` and `test:ui:install`, and every local reference to `test:ui:install`: `AGENTS.md:116`, `docs/LOCAL_STACK.md:28`, `scripts/README.md:74`, and the hint text in `platform/test/test-stack.integration.test.ts:79` and `scripts/test-stack-prerequisites.mjs:118`.
- The `all-checks-passed` needs.
- `pnpm lint:ci` passes.

## 1. Implementation

- [x] 1.1 Initial `container:` attempt (`e392b78`). Superseded: CI proved that `pnpm install` cannot build better-sqlite3 in the image (no `make`).
- [x] 1.1a Rework per proposal § What Changes (owner decision, 2026-11-22).
  - Remove `container:` and add job `env: PLAYWRIGHT_IMAGE`.
  - The guard step pulls the image and reads `/ms-playwright/.docker-info` through `docker run`, then compares it with the host's `@playwright/test`. It fails closed.
  - The test step is `docker run` of the image with: the workspace mounted read-write at its own path; host Node and pnpm mounted read-only and first on `PATH`; `--user` set to the runner's uid and gid; a writable `HOME`; and `pnpm test:ui` as the command.
  - The host steps and the artifact step are unchanged.
- [x] 1.2 The guard logic, compare and fail-closed, from `e392b78`. It is kept and moved into 1.1a's guard step.
- [x] 1.3 Update `platform/web/README.md:11` as described in proposal § What Changes. Re-word it for the 1.1a design.

## 2. Verification

- [x] 2.1 Run `pnpm fmt:check` and `pnpm lint` (including `lint:ci`). Then extract the guard step from `ci.yml` and run it on the host with different `PLAYWRIGHT_IMAGE` values:
  - Pinned digest: exit 0.
  - `v1.62.0-noble`: exit 1, both versions printed.
  - A nonexistent reference: exit 1.
  - A stub `docker` that prints empty output, invalid JSON, `null`, or a record without `driverVersion`: exit 1 each.
  - The real record hidden with `--tmpfs`, or replaced by an empty file: exit 1.
- [x] 2.2 Collect at least 5 `platform-ui` executions on this PR (reruns of the job). For each, record:
  - the guard step's seconds (which include the image pull), the test step's seconds and the job's seconds;
  - whether the pnpm cache hit or missed;
  - that no `archive.ubuntu.com` or `Fetched` line appears in the log;
  - that the screenshots artifact was uploaded.
- [x] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
