# Design

Change surface: `rawAsync` inside `createDockerCommands` (`platform/test/docker-command.ts:216-278`), reached through `commandAsync`/`externalAsync` by 35 test files; `endInput` (`platform/test/local-script.ts:11-21`) moved to `platform/test/child-input.ts`.

Must preserve:

- Result shape `{ status, stdout, stderr, error?, signal? }`; `status: null` whenever `error` is set.
- `rawAsync` settlement contract pinned in `docker-version.integration.test.ts:651-689`: timeout (`ETIMEDOUT`), overflow (`ENOBUFS`) and spawn failure (`ENOENT`) settle only after the child's `close`; the first two carry `SIGKILL`; with no input the child receives EOF (`:676-689`).
- The first termination cause wins: a later stdin failure never overwrites `ETIMEDOUT`/`ENOBUFS`/spawn error, and vice versa.
- Bounded instances (`createDockerCommands(..., true)`) still pass failures through `redactResult` (`:155-163`), which drops `error` and returns the fixed `Web Docker operation failed` text.
- Injected-command path: never spawns, never touches stdin.
- `localScript` behavior and its two cases.

Must add/change:

- `rawAsync` ends stdin through `endInput(child.stdin, input)` and resolves only when both the child's `close` and the `endInput` promise have settled.
- On `endInput` rejection (non-`EPIPE`): record it as a termination cause through the same path as `terminate` (set `error` if unset, kill with `options.killSignal`).
- `EPIPE`, `ECONNRESET` (Linux socketpair peer closed with unread data) or a clean stdin close is not a failure; `endInput` gains `ECONNRESET` with its own unit case.

Governing invariant: every `commandAsync` call settles exactly once, within its timeout plus kill latency, with no uncaught exception or unhandled rejection, whatever the child does with its stdin.

Sibling surfaces:

- `localScript` (`local-script.ts`): already uses `endInput`; only its import changes.
- `e2e-command-fixture.ts:51`, `scripts/ci-vps-invoke.mjs:79`: listen on stdin but swallow every error. Out of scope (issue #733 names them as not this defect); no change.
- `docker-cleanup.ts:231` and similar `end()` calls: write no data, so no EPIPE window; no change.
- Synchronous `spawnSync` path (`externalCommand`): input is never streamed; not affected.

Seams under test: `createDockerCommands(...).commandAsync` with a real spawned child (spawn stand-in in `docker-command.integration.test.ts`, or the `withCommands` harness in `docker-version.integration.test.ts`); `endInput` directly in `child-input.integration.test.ts`.

Required evidence:

- 8 MB input to a child that writes `done` and exits without reading → `{ status: 0, stdout: 'done', stderr: '' }`; the file's vitest run exits 0 (red before: uncaught `write EPIPE`, rc 1, on a host that reproduces it — macOS reproduced 30/30 in #731). Green after must also hold on Linux: CI `layer3-integration` (ubuntu) runs this file and the `localScript` 8 MB case on the PR head.
- Unbounded instance (`bounded=false`), stdin failing with an `EIO`-coded error, child that never exits (`setInterval`) and timeout 10 s → settles well under the timeout with `status: null`, `error.code === 'EIO'`, child `signalCode === 'SIGKILL'`; no uncaught exception or unhandled rejection.
- Existing `docker-version.integration.test.ts` settlement cases and the echo case stay green.

Non-goals: changing `e2e-command-fixture.ts` or `ci-vps-invoke.mjs`; changing `redactResult`; changing the injected-command path.

Review focus:

- No path where `error` is set by stdin while the child lives and nothing kills it.
- Settlement waits for both events and cannot deadlock when spawn fails (stdin is destroyed on exit).
- One `endInput` implementation; `docker-command.ts` does not import a stack fixture.
