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

- **Run `platform-ui` in the official Playwright image.**
  - The job gets `container: image: mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`. This is the multi-arch index digest; the amd64 manifest is `sha256:bc6ab0d6…54c7`.
  - The image already contains Chromium at `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, plus the fonts and libraries that `--with-deps` installs.
  - It is pulled from the container registry, not from the Ubuntu apt mirror.
  - The tag version equals the pinned `@playwright/test` version, 1.63.0.
- **Replace the browser install step with a drift guard that reads the image itself.**
  - The image build ran `playwright-core mark-docker-image`. It wrote `/ms-playwright/.docker-info` with `{driverVersion, dockerImageName}` (playwright-core 1.63.0).
  - An inline step compares `require('@playwright/test/package.json').version` with that file's `driverVersion`. On a mismatch, or when the file is missing or unparsable, it prints both versions (with `dockerImageName`) and exits 1.
  - No browser install runs in CI, so nothing can download a browser or call apt.
  - A `@playwright/test` bump that leaves the image digest unchanged fails this step loudly. This is intended gate behaviour.
  - Dependabot updates only `npm` and `github-actions` `uses:` (`.github/dependabot.yml`). It never bumps `container.image`, so each Dependabot Playwright PR reds here until a human moves the digest in the same PR. No Dependabot `ignore` is added.
  - `package.json` `test:ui:install` stays as it is for local use.
- **Unchanged:**
  - `checkout`, `pnpm/action-setup` and `setup-node` (Node from `.tool-versions`, `cache: pnpm`), with the same SHA pins;
  - `pnpm install --frozen-lockfile`, `pnpm test:ui`, the artifact upload step;
  - `timeout-minutes: 10`.
- **Docs.** `platform/web/README.md:11` ("Install the pinned verification browser explicitly with `pnpm test:ui:install`…") gains three points:
  - CI runs in the pinned Playwright image instead;
  - to upgrade, take the index digest from `docker buildx imagetools inspect mcr.microsoft.com/playwright:v<ver>-noble` and change it together with `@playwright/test` in the same PR;
  - Dependabot does not bump the image, so its Playwright PRs are red by design.
- **Expected effect.**
  - The fetch cost moves to the runner's `Initialize containers` step. The amd64 layers are about 0.96 GB compressed.
  - This removes the apt long tail: normal runs took 20–51 s and the worst took 557 s.
  - It does not promise a faster median. The pull time is an estimate; for reference, `sast` pulled the Semgrep image in 12 s in run 44723645299.

## Triage

```text
Issue type: bugfix
Fixture level: compact
Upstream suggested level: absent
Blast radius: one required CI job (platform-ui); a broken container setup reds every PR until fixed; .github/workflows change needs flagging
Selected risk packs: Config / project setup (CI job container, pinned digest, version guard); Release / packaging / dependency compatibility (the image's own driverVersion must equal @playwright/test); Resource limits (a ~0.96 GB image pull inside the 10-minute budget)
Evidence floor: this PR's platform-ui runs: at least 5 executions (reruns), each with Initialize-containers seconds, guard seconds, job seconds and pnpm cache hit/miss, no `archive.ubuntu.com` fetch in any log, screenshots artifact uploaded; the guard step run locally inside another published Playwright image (mismatch → nonzero, both versions printed) and inside the pinned digest (→ 0); pnpm fmt:check; pnpm lint incl. lint:ci; exact-head VPS lane (repository gate)
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
