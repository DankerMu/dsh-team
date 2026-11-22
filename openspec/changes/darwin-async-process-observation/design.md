# Design

## Change surface

- `darwinObservation` in `scripts/probe-browser-native.mjs`.
- `browser-native.integration.test.ts`, whose mock moves from `spawnSync` to `spawn` and gains new cases.
- The `spawn` mock in `browser-exec.integration.test.ts`, which now passes the observer through.

## Must preserve

- The Linux branch of `processObservation`, byte for byte.
- The Python program text, argv (`-I -c <program> <pid>`), env (`PATH=/usr/bin:/bin`, `LC_ALL=C`), the 2000 ms bound and `SIGKILL`.
- The parsing and the three outcomes (identity, `ESRCH`, unavailable).
- `processBirth`/`liveProcessBirth` names and signatures, as declared in `scripts/probe-browser-runtime.d.mts:49`.
- Every existing case and assertion in `browser-native.integration.test.ts` and `browser-exec.integration.test.ts`. Only the mock mechanism changes.

## Must add/change

`darwinObservation` becomes:

- `spawn` with `stdio: ['ignore', 'pipe', 'ignore']`. The Python program writes to stderr only on a nonzero exit.
- stdout collected as `Buffer` bytes, with the cap counted in bytes and exceeded strictly above 4096, as `maxBuffer` does. On overflow, SIGKILL is sent and the result is unavailable. UTF-8 is decoded once, at `close`.
- A 2000 ms timer that sends SIGKILL. A timed-out flag wins even if `close` later reports code 0.
- Settling exactly once, on the first of `error` or `close`. The settlement is guarded, the timer is cleared, and later events are ignored. Node does not promise `close` after every `error`.
- Clearing the timer on every path.
- On a synchronous `spawn` throw or an `error` event, rejecting with a fresh `Error('browser process birth identity unavailable')` that has no `code`. Otherwise a spawn ENOENT would leak through, and `liveProcessBirth` (`probe-browser-native.mjs:112`) would turn unavailable into absence.
- If the child has no stdout (Node's EMFILE/ENFILE path, which returns no stdio and emits `error` on the next tick), the observation settles as unavailable. The `error` listener is attached before any stdio access, so the deferred `error` is absorbed (review round 1).

## Governing invariant

A Darwin birth observation never blocks the event loop, resolves to the same three outcomes, and never reports uncertainty as absence.

## Caller audit (recorded, cff437f)

- Every caller of `processBirth`/`liveProcessBirth` in `scripts/` awaits.
- The `SIGINT`/`SIGTERM` handlers (owner `:317-318`, runtime `:703-706`) only queue work.
- `probe-dsh-api-cdp.mjs:341` and the external `retireNative` path run only on Linux.
- The only fan-out is a small bounded `Promise.all` in `platform/test/browser-build-fixture.ts:108`.

## Ordering

Because the observation now yields, the child's `exit` and reap can be delivered between `signalOwnedGroup`'s `exitCode` check and `process.kill(-pid)` (`trusted-docker-owner.mjs:162-169`). The Linux branch, which uses an async `readFile`, already has this window. This change brings Darwin in line with accepted behaviour; it adds no new risk.

## Seams under test

`vi.mock('node:child_process')` maps `/usr/bin/python3` to a real stand-in, `actual.spawn(process.execPath, ['-e', script], options)`, and captures the child:

| Case                                              | Stand-in behaviour                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| zombie, gone, unknown state, invalid microseconds | write the canned stdout, then exit 0                                        |
| denied                                            | `exit(1)` with empty stdout                                                 |
| missing interpreter                               | a nonexistent absolute path, which gives a real asynchronous ENOENT `error` |
| hung                                              | `setTimeout(() => {}, 60000)`                                               |
| oversized                                         | write more than 4096 bytes, then sleep past the bound                       |

For the red run, the `spawnSync` branch routes `/usr/bin/python3` to the hung stand-in through `actual.spawnSync`. After the fix, that branch throws.

## Required evidence

- **Hung case, red before:** the timer fires after the observation.
- **Hung case, green after:** the timer fires before it; the rejection comes no earlier than the bound, measured with `performance.now()` from just before the call; the child shows `signalCode === 'SIGKILL'`, then ESRCH.
- **Oversized case:** the rejection comes before a 1000 ms timer started at the captured child's `spawn` event (cap kill ≪ 1000 ms < 2000 ms bound), and SIGKILL is recorded. This is a characterization test against the cap: without the cap, the 2000 ms bound would still stop the writer, but after the 1000 ms timer.
- **Missing interpreter:** the rejection has no `code`, and `liveProcessBirth` rejects rather than returning `null`.
- **Regression runs:** `browser-native`, `browser-exec`, custody, retirement and cancellation stay green on macOS. Then `pnpm check` and the VPS lane.

## Non-goals

`signalOwnedGroup`'s `ps`, #636, #653, #656 and #687.

## Review focus

- Exactly-once settlement.
- Byte cap and kill.
- Timeout precedence.
- No `code` leak.
- No leaked child or timer.
- The `browser-exec` passthrough.
