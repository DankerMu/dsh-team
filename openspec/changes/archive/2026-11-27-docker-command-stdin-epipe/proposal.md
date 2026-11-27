# Contain stdin pipe errors in the Docker boundary's async command

## Why

Issue #733, left over from #717. Line numbers refer to main `811f5de`.

- `createDockerCommands`' real `commandAsync` (`platform/test/docker-command.ts:216-278`) spawns the Docker CLI and calls `child.stdin.end(input)` (`:229`) with no `error` listener on `child.stdin`. Only the child has one (`:263`).
- When the CLI exits before reading its input (missing container, refused exec, failure before attach), Node raises `write EPIPE` on stdin. Nothing handles it, so it is an uncaught exception: vitest exits 1 even when every case passed, and a real failure is buried under the noise.
- The one real caller with input is `holderRead` (`document-server-net-fixture.ts:89-95`), which passes the Document Server JWT to `docker exec -i` in the `pnpm test:stack` lane (`platform-stack.stack.test.ts`).
- PR #731 added `endInput(stdin, input)` in `platform/test/local-script.ts:11-21` for the same defect in the local script runner. It ignores only `EPIPE` and a clean close, and rejects any other stdin error. `local-script.ts` imports `NODE` from `office-isolation-stack-fixture.ts`, so the Docker boundary cannot import it from there without depending on a stack fixture.

## What Changes

- `endInput` moves to a new neutral module `platform/test/child-input.ts`. Its three unit cases move from `local-script.integration.test.ts` to a new sibling `child-input.integration.test.ts`. `local-script.ts` imports it from there. One implementation remains in the repository. It also tolerates `ECONNRESET`: on Linux, libuv's child stdio is an `AF_UNIX` socketpair, and a child that exits with unread input makes the kernel report `ECONNRESET` to the writer (`unix_release_sock`), not `EPIPE`. Both mean the child closed its end without reading; any other stdin error still rejects.
- `rawAsync` (`docker-command.ts`) ends stdin through `endInput` and consumes its promise:
  - The result settles only after both the child's `close` and the stdin settlement.
  - A non-`EPIPE` stdin error is a termination cause, like `ETIMEDOUT` and `ENOBUFS`: it becomes the result's `error` unless one is already set, and the child is killed with the same signal at once. The input was not delivered, so the command cannot be trusted to finish; killing it keeps the settlement bounded even though `terminate()` ignores later causes once `error` is set. The result carries `status: null`, the `error`, and the kill signal when the child was still alive. It never becomes an uncaught exception or an unhandled rejection.
  - `EPIPE`, `ECONNRESET` and a clean close are not failures: the child's own status and output are the result.
  - A call without `input` still closes stdin empty.
- The injected-command path is unchanged.

## Triage

```text
Issue type: test-infrastructure bugfix
Fixture level: expanded
Upstream suggested level: absent (fixture review: shared entrypoint `commandAsync` used by 35 test files, and a new two-event settlement ordering)
Blast radius: platform/test Docker boundary used by every Docker-backed integration, docker and stack test; no product code
Selected risk packs: Error handling; Legacy compatibility; Concurrency / ordering; Resource limits / large input
Evidence floor: red-before/green-after cases in docker-command.integration.test.ts (the single file's vitest rc); docker-version.integration.test.ts rawAsync settlement cases; pnpm test:integration; pnpm duplicate-code; pnpm lint:deps; one local pnpm test:stack on the final head; exact-head VPS pnpm test:docker + pnpm test:deploy
```

## Capabilities

### Modified Capabilities

- `stack-verification`: the child-input requirement now also covers the Docker boundary's async command, and a non-`EPIPE` stdin error there settles as a failed result.

## Impact

- `platform/test/docker-command.ts`, `docker-command.integration.test.ts` and/or `docker-version.integration.test.ts`, `local-script.ts`, `local-script.integration.test.ts`; new `platform/test/child-input.ts` and `child-input.integration.test.ts`.
- Out of scope: `e2e-command-fixture.ts:51` and `scripts/ci-vps-invoke.mjs:79` swallow every stdin error; `docker-cleanup.ts` `end()` calls write no data. None of these is this defect.
