# Darwin asynchronous process observation

## Why

This is issue #659. Line numbers refer to main `cff437f`.

On Darwin, `processObservation` calls `darwinObservation` (`scripts/probe-browser-native.mjs:37-80`). That function runs `spawnSync('/usr/bin/python3', …, { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 4096 })` (`:62-68`). It is declared `async`, but the call still blocks the event loop.

`signalOwnedGroup` (`scripts/trusted-docker-owner.mjs:154-172`) makes one attempt in three steps:

- `ownerIsLive`, which performs a Darwin observation;
- `spawnSync('/bin/ps', …, { timeout: 2000 })`;
- a second `ownerIsLive`.

On Darwin that blocks for up to about 6 s per attempt. Linux blocks only for the `ps` call, about 2 s. The retry runs every `retryMs` (1 s) (`:205-250`), so under sustained failure the Darwin owner is frozen for about 6/7 of the time. It cannot drain the child's output pipes, and its timers slip.

The archived residual-risk argument (`openspec/changes/archive/2026-11-20-stage-2-dsh-ragflow-office/tasks.md:6775`) claims "每次 `spawnSync` 最多阻塞事件循环 2 秒 … owner 仍能读 child 的输出管道". That argument does not hold on Darwin.

The 6 s figure is derived from the code, not measured. The fault only affects Darwin development hosts. The trusted lane on giap-vps runs Linux.

## What Changes

- `darwinObservation` uses asynchronous `spawn` and awaits the child's `close`. It keeps the same contract:
  - the same program, argv, environment and `encoding`;
  - a 2000 ms timeout enforced by a timer that sends `SIGKILL`;
  - an equivalent of the 4096-byte `maxBuffer`: output beyond 4096 bytes kills the child and is treated as unavailable;
  - the same parsing.
- The error semantics stay the same:
  - spawn error, nonzero status, signal or timeout → `browser process birth identity unavailable`;
  - `gone\n` → an error with `code: 'ESRCH'`;
  - a non-matching `ok` line → unavailable.
- `processObservation` and `processBirth`/`liveProcessBirth` keep their interfaces (declared in `scripts/probe-browser-runtime.d.mts:49`). The caller audit is recorded in design.md: every caller awaits, and none runs in a synchronous context.
- There is no production seam. Tests use the repository's existing idiom: `vi.mock('node:child_process')` maps `/usr/bin/python3` to a real stand-in child (`actual.spawn(process.execPath, ['-e', …])`), as in `browser-exec.integration.test.ts:68-78` and `docker-command.integration.test.ts:42-46`.
- `browser-exec.integration.test.ts` mocks `spawn` and rejects any non-`docker exec` process (`:65-67`). On macOS it reaches the Darwin branch for real, through `processBirth(process.pid)` (`:200`) and `rescueChrome` (`:334`). Its `spawn` mock must pass `/usr/bin/python3`, and only that, through to the real `spawn`. This changes the mock mechanism; no assertion changes.
- `browser-native.integration.test.ts` mocks `spawnSync` today. It moves to a `spawn` mock with the same cases (zombie retained, `gone`, missing interpreter, denied query, unknown state, invalid microseconds), and every case keeps its assertions.
- A new deterministic case uses a hanging stand-in, a single Node process. Its assertions:
  - a 50 ms timer fires before the observation settles;
  - the rejection is the unavailable error and arrives no earlier than the bound;
  - the captured child has `signalCode === 'SIGKILL'`, and `process.kill(pid, 0)` then gives ESRCH.
- For the red run, the mock also routes `spawnSync('/usr/bin/python3')` to the same hanging stand-in through `actual.spawnSync`, so the old code really blocks and the ordering assertion fails. After the fix, the mock's `spawnSync` branch for `/usr/bin/python3` throws, which locks AC1.
- With the fix, a Darwin attempt blocks only for `ps`, the same as Linux, so the archived 2 s argument holds again. The PR says so, and the archive is left unchanged.

## Triage

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent
Blast radius: process identity for trusted custody, audit, verification producers, browser runtime, CI VPS units and the DSH CDP probe on Darwin; a semantic slip (gone vs unavailable, timeout) could mis-signal or misreport ownership; Linux path untouched
Selected risk packs: Concurrency / shared state / ordering (event loop no longer blocked; timer/close ordering); Error handling / rollback / partial outputs (timeout, kill, oversized output, gone vs unavailable); Auth / permissions / secrets (process identity authority — never claim absence on uncertainty)
Evidence floor: new timer case red before / green after on Darwin; existing native and browser-exec cases unchanged and green; trusted-docker-custody, -retirement, -cancellation integration green locally (macOS); pnpm check; exact-head VPS test:docker + test:deploy (Linux path unchanged)
```

## Capabilities

### Modified Capabilities

- `trusted-docker-verification`: the Darwin process birth observation does not block the owner's event loop.

## Impact

- `scripts/probe-browser-native.mjs` (`darwinObservation`)
- `platform/test/browser-native.integration.test.ts`
- `platform/test/browser-exec.integration.test.ts` (its `spawn` mock passes the Darwin observer through)
- `scripts/` is not listed under Critical Paths, but the change touches trusted custody identity, so the PR asks for line-by-line review
