# The holder script test runs the script under the production shell

## Why

Issue #752 was found while measuring #741. Line numbers refer to main `71cf68d`.

- **The test shell is not the production shell.** `platform/test/document-server-net-script.integration.test.ts:75` runs the holder with `spawn('/bin/sh', [SCRIPT], …)`. On macOS, `/bin/sh` is bash 3.2.57.
- **The production shell is dash.** The container's entrypoint is `/app/deploy/document-server-net.sh` (`deploy/compose.yml:63-64`). Its shebang is `#!/bin/sh`, and the image is based on `node:24.13.1-bookworm-slim` (`platform/Dockerfile:24`).
  - Observed in the linux/amd64 platform image that PR #751's lane built from `c016b84`: the layer listing has `usr/bin/sh -> dash`, `usr/bin/dash` and `usr/bin/bash`.
- **The bash failure (from #752's probe).** Under bash 3.2, the first SIGTERM is occasionally not acted on.
  - Rate: 3 hangs in 1440 rounds, each time with the TERM sent about 0.4 ms after the marker appeared.
  - State while hung: the script sits in `wait4` with `sleep 1000` running. A second TERM makes it exit 0.
  - Effect on the test: the 3 held cases fail intermittently on macOS with `timedOut: 'exit'`.
- **Apple's dash did not reproduce it.** 0 hangs in 4320 rounds. Debian's and Ubuntu's dash were not probed.
- **Inferred, not confirmed:** the TERM lands between forking `sleep infinity &` and entering `wait`.
- **Impact is inferred to be test-only.** This rests on two things: the image's `/bin/sh` is dash, and Apple's dash showed 0 hangs in 4320 rounds. On that basis the test exercises a shell that production never runs, and CI on `ubuntu-24.04`, whose `/bin/sh` is dash, is inferred to be unaffected. The behavior of Debian and Ubuntu dash in this window was not probed.
- **Other entrypoints.** A grep for `trap … & wait` entrypoints matches only `scripts/{e2e-scenario,dev-server,probe-first-run,probe-dsh-api,probe-sandbox}.sh`. All of them are `#!/usr/bin/env bash` host scripts, and none is a compose or Dockerfile entrypoint. Only `deploy/document-server-net.sh` runs as PID 1 under `/bin/sh` (`deploy/compose.yml:63-64`).

## What Changes

This is the issue's recommended option.

- **The test spawns the production shell explicitly:** `spawn('/bin/dash', [SCRIPT], …)`.
  - A comment says it matches the image's `/bin/sh` (#752).
  - If `/bin/dash` is missing, the case fails; it never falls back to another shell. An explicit existence check before the spawn throws an error naming `/bin/dash`, so the failure does not look like a `timedOut: 'ready'`.
  - `/bin/dash` exists on macOS and on Ubuntu.
- **The `EXIT_MS` comment changes.** Today it says "A rare hang here is a lost SIGTERM under macOS bash 3.2 (#752)". That is no longer the shell under test, so the comment instead states which shell the test runs and that #741's maxima were measured under bash.
- **The probe stays outside the repository** as evidence. It has a bounded N, kills the process group every round, and counts hangs under bash. The same N then runs under `/bin/dash` and must show 0 hangs, with every round exiting `code: 0` within `EXIT_MS`. Its results are recorded in the PR.
  - It is not committed because it is probabilistic and slow: at about 1/480, finding at least 3 hangs needs N ≥ 3000 rounds.
- **Unchanged:**
  - `deploy/document-server-net.sh` and `deploy/compose.yml`;
  - `EXIT_MS`, `expect(bound).toBe(EXIT_MS)` and the `CASE_TIMEOUT_MS` formula;
  - every other assertion.

`design.md` is omitted at compact level: the change is one test's shell and a comment, and the probe evidence lives outside the repository.

## Ordering

This change rewrites the comment that PR #753 (#741) adds, so it is implemented only after #753 has merged.

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent (override: none upstream; compact because the change is one test's interpreter and a comment)
Blast radius: the 3 held cases and the non-held rows of document-server-net-script.integration.test.ts
Selected risk packs: Concurrency / shared state / ordering (signal delivery window); Legacy compatibility (the measured basis from #741)
Evidence floor: bash red probe (N >= 3000, K >= 3 hangs) and the same N under /bin/dash with 0 hangs; image /bin/sh recorded; the file passes; 5 loaded full pnpm test:integration runs; exact-head VPS lane
```

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `integration-test-budgets`: the firewall holder script cases run the script under the production shell.

## Impact

- `platform/test/document-server-net-script.integration.test.ts`: the spawned interpreter and the `EXIT_MS` comment.
