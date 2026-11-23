# Platform UI job runs in the pinned Playwright image

## Why

Issue #667. Line numbers refer to main `ffaa137`.

The required `platform-ui` job (`.github/workflows/ci.yml`) runs on a plain `ubuntu-24.04` runner with `timeout-minutes: 10`, in three steps:

- `pnpm install`
- `pnpm test:ui:install`, which is `playwright install --with-deps chromium` (`package.json:35`)
- `pnpm test:ui`

`--with-deps` fetches about 32 MB of fonts and mesa packages from the Ubuntu apt mirror on every run. The issue sampled 41 executions:

| Measurement                            | Result              |
| -------------------------------------- | ------------------- |
| Time spent in this step                | 2 s to 8 min 24 s   |
| `test:ui:install` taking 100 s or more | 15 of 41 (37%)      |
| 10-minute cancellations                | 2                   |
| Mirror 503 ending in `exit code: 100`  | 1                   |
| `pnpm test:ui` itself                  | stable at 120–166 s |

Each failure reds `All checks passed`, and the PR then needs a manual rerun.

## What Changes

The design was revised on 2026-11-22, after the first CI run of PR #698. A job-level `container:` cannot run `pnpm install`: better-sqlite3 13.0.3's install ran `node-gyp rebuild` there, and the image has no `make` or compiler (`gyp ERR! stack Error: not found: make`). Installing build tools in the job would bring back the apt dependency. Owner decision: compile on the host, and run the tests in the image.

- **Host steps stay as they are.** `platform-ui` keeps `runs-on: ubuntu-24.04` and runs these on the host, which already has the build toolchain:
  - checkout;
  - `pnpm/action-setup`;
  - `setup-node` with Node from `.tool-versions` and `cache: pnpm`;
  - `pnpm install --frozen-lockfile`.

  So better-sqlite3 is compiled by the host toolchain for the host Node 24.13.1.

- **One image reference.** A job-level `env: PLAYWRIGHT_IMAGE: mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27` holds it. This is the multi-arch index digest; the amd64 manifest is `sha256:bc6ab0d6…54c7`. Both docker steps use it.
- **Guard step.** It replaces `pnpm test:ui:install`. It pulls the image and reads `/ms-playwright/.docker-info`, which the image build wrote via `playwright-core mark-docker-image` and which contains `{driverVersion, dockerImageName}`. It then compares that `driverVersion` with the host's `require('@playwright/test/package.json').version`.
  - A mismatch, a missing record or an unparsable record exits 1 and prints both versions and `dockerImageName`.
  - No `playwright install` or apt call runs anywhere in the job.
  - A `@playwright/test` bump that leaves the digest unchanged fails here loudly; this is intended gate behaviour.
  - Dependabot updates only `npm` and `github-actions` `uses:` (`.github/dependabot.yml`). It never bumps the image, so each Dependabot Playwright PR goes red here until a human moves the digest in the same PR. No Dependabot `ignore` is added.
- **Test step.** It runs `pnpm test:ui`, verbatim, inside the image with `docker run`:
  - The workspace is mounted read-write at its own path.
  - The host Node directory and the pnpm installation are mounted read-only and put first on `PATH`. The tests therefore run with the same Node binary that compiled the binding (identical ABI). Host and image are both Ubuntu 24.04, so glibc matches too.
  - The container runs as the runner's uid and gid with a writable `HOME`. Files it writes (the web build and `reports/platform-ui/`) stay owned by the runner, so the artifact step uploads them as before.
  - The image contributes only Chromium (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`) and the fonts and libraries that `--with-deps` used to install.
- `package.json` `test:ui:install` stays as it is for local use.
- **Unchanged:**
  - `runs-on: ubuntu-24.04`, `checkout`, `pnpm/action-setup` and `setup-node` (Node from `.tool-versions`, `cache: pnpm`), with the same SHA pins;
  - `pnpm install --frozen-lockfile` on the host, the `pnpm test:ui` command, and the artifact upload step;
  - `timeout-minutes: 10`.
- **Docs.** `platform/web/README.md:11` ("Install the pinned verification browser explicitly with `pnpm test:ui:install`…") gains three points:
  - CI runs the UI tests inside the pinned Playwright image, using the host's Node and pnpm;
  - to upgrade, take the index digest from `docker buildx imagetools inspect mcr.microsoft.com/playwright:v<ver>-noble` and change it together with `@playwright/test` in the same PR;
  - Dependabot does not bump the image, so its Playwright PRs are red by design.
- **Expected effect.**
  - The fetch cost moves to the guard step's image pull. The amd64 layers are about 0.96 GB compressed; the first CI run's `Initialize containers` pulled them in 17 s.
  - This removes the apt long tail: normal runs took 20–51 s and the worst took 557 s.
  - It does not promise a faster median. The pull time is an estimate; for reference, `sast` pulled the Semgrep image in 12 s in run 44723645299.

## Triage

```text
Issue type: bugfix
Fixture level: compact
Upstream suggested level: absent
Blast radius: one required CI job (platform-ui); a broken docker-run setup reds every PR until fixed; .github/workflows change needs flagging
Selected risk packs: Config / project setup (CI job container, pinned digest, version guard); Release / packaging / dependency compatibility (the image's own driverVersion must equal @playwright/test); Resource limits (a ~0.96 GB image pull inside the 10-minute budget)
Evidence floor: this PR's platform-ui runs: at least 5 executions (reruns), at least one with a cold pnpm cache showing the host better-sqlite3 install, each with guard (pull) seconds, test seconds, job seconds and pnpm cache hit/miss, no `archive.ubuntu.com` fetch in any log, screenshots artifact uploaded; the guard step run locally on the host against another published Playwright image (mismatch → nonzero, both versions printed), a nonexistent reference and stubbed unreadable records (→ nonzero), and the pinned digest (→ 0); pnpm fmt:check; pnpm lint incl. lint:ci; exact-head VPS lane (repository gate)
```

design.md is omitted (compact).

## Capabilities

### Modified Capabilities

- `browser-runtime-verification`: the platform UI CI lane gets its browser and system libraries from a pinned image that matches the Playwright package.

## Impact

- `.github/workflows/ci.yml`, the `platform-ui` job only. This is a workflow change and is flagged in the PR.
- The platform UI lane documentation.
- No product code, no test assertion change and no timeout change.
- Out of scope: caching `~/.cache/ms-playwright`; the unit job's one-off cancellation.
