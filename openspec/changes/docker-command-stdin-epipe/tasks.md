## Risk packs

- **Error handling (selected).** `EPIPE` contained; a non-`EPIPE` stdin error settles the result with `error`; no unhandled rejection. Tasks 1.2, 1.3.
- **Legacy compatibility (selected).** `holderRead`, the existing echo case (`docker-command.integration.test.ts` "writes the declared input to a live command and closes stdin empty otherwise"), every `commandAsync` caller without input, and both `localScript` callers keep their behavior. Tasks 1.1, 1.4, 2.
- **Concurrency / ordering (selected).** Settlement joins the child's `close` and the stdin settlement; a stdin failure kills the child so the join cannot wait forever; first termination cause wins. Tasks 1.3, 1.4, 2.1 (existing `docker-version` settlement cases).
- **Resource limits / large input (selected).** 8 MB input to a non-reading child (task 1.2); timeout and output-limit termination keep `ETIMEDOUT`/`ENOBUFS` and `SIGKILL` (existing `docker-version.integration.test.ts:651-674`, task 2.1).
- **Not selected:**
  - Public API / CLI: no entrypoint changes; `AsyncDockerCommand`'s signature is unchanged.
  - Config, schema, auth/secrets: the JWT is still written to stdin only; nothing new is logged.
  - File IO, release, docs: none touched.

## Must preserve

- `commandAsync(args, timeout, input)` result shape: `{ status, stdout, stderr, error?, signal? }`, with `status: null` whenever `error` is set.
- Timeout (`ETIMEDOUT`) and output-limit (`ENOBUFS`) termination keep their codes; a stdin failure never overwrites an earlier `error`, and an earlier stdin failure is not overwritten by them.
- `docker-version.integration.test.ts:651-689`: timeout, overflow and spawn failure settle only after the child closes (first two with `SIGKILL`); no input gives the child EOF.
- Bounded instances still redact failures through `redactResult` (`docker-command.ts:155-163`).
- The injected-command path never spawns and never touches stdin.
- `localScript`'s behavior and its two existing cases (non-reading child with 8 MB input, reading child receives all of it).

## 1. Implementation

Write each case first and record its red output, then change the code.

- [ ] 1.1 Move `endInput` to `platform/test/child-input.ts` (`input` may become optional so the no-input call closes stdin empty). It also ignores `ECONNRESET` (Linux socketpair peer closed with unread input). Move its three cases (`EPIPE` ignored, clean close ignored, other error rejects) to `child-input.integration.test.ts` and add a fourth: `ECONNRESET` ignored (red before: rejects). `local-script.ts` imports it.
- [ ] 1.2 Red case, non-reading child: extend the existing `node:child_process` spawn stand-in in `docker-command.integration.test.ts` with a mode whose child exits without reading stdin. Call the real `commandAsync` with an input far above a pipe buffer (8 MB, as in #731). The stand-in child writes `done` and exits without reading. Assert the result equals `{ status: 0, stdout: 'done', stderr: '' }`.
  - Red evidence: before the fix, `pnpm exec vitest run --project integration platform/test/docker-command.integration.test.ts` exits 1 with an uncaught `write EPIPE` (or the run reports an unhandled error). After the fix it exits 0.
- [ ] 1.3 Red case, other stdin error, child that never exits: an **unbounded** instance (`createDockerCommands(root, config, false)`, so `redactResult` does not drop `error`), a child that never exits (`setInterval`), timeout 10 000 ms, and its stdin destroyed with an `EIO`-coded error right after spawn. Assert the result settles in well under the timeout, equals `{ status: null, stdout: '', stderr: '', error: <code 'EIO'>, signal: 'SIGKILL' }` (match `error` with `toMatchObject({ code: 'EIO' })`), and that the run records no uncaught exception or unhandled rejection.
  - Red evidence: before the fix the file's run reports the uncaught stdin error (and the case only settles at the 10 s timeout with `ETIMEDOUT`).
- [ ] 1.4 `rawAsync` uses `endInput` and settles after both the child's `close` and the stdin settlement. A rejection goes through the `terminate` path: `error` set if unset, child killed with `options.killSignal`.

## 2. Verification

- [ ] 2.1 `pnpm exec vitest run --project integration platform/test/docker-command.integration.test.ts platform/test/child-input.integration.test.ts platform/test/local-script.integration.test.ts platform/test/docker-version.integration.test.ts`: exit 0.
- [ ] 2.2 `pnpm test:integration`, `pnpm lint`, `pnpm typecheck`, `pnpm dead-code`, `pnpm duplicate-code`, `pnpm lint:deps`, `pnpm lint:tests`: exit 0.
- [ ] 2.3 One local `pnpm test:stack` on the final head (`holderRead` is its only real caller with input).
- [ ] 2.5 CI `layer3-integration` (Linux) green on the PR head: Linux evidence for 1.2 and the `localScript` 8 MB case.
- [ ] 2.4 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy` (Docker evidence gate).
