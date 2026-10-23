# Context

`trusted-docker-custody.integration.test.ts` waits for owned process readiness with bare `vi.waitFor` (Vitest default 1000ms, 50ms interval) at `:47` (`cancelHeldCommand`, two callers), `:223` (`it.each`, four variants), `:279` (`sentinel-ready`), `:296`, `:304`, `:356`, `:364` and `:395`. `fixture.start()` returns once the owner publishes `child.json` (`trusted-docker-fixture.ts` ~`:429-434`), which is the measurement origin. The leaf writes `child-ready.json` with a plain `writeFileSync` (`trusted-docker-fixture.ts:161`), as does the past-expiry member record `group-member.json` (`:159`). #324 measurements (comment 6371840383): leaf readiness max 1799ms (Linux 6 concurrent + 8 burners), sentinel max 183ms, `fixture-begin` max 82ms after `child-ready`; one Darwin 4-concurrent run saw `child-ready.json` existing but empty.

# Decisions

1. **Atomic publication at the producer.** The generated leaf script gets a local `publish(name, value)` that writes `<name>.pending` (mode 0600) and renames it in the same owned temporary directory, the same inline pattern as `browser-wrapper-docker-fixture.ts:97-101`. Both `child-ready.json` and `group-member.json` use it. The sentinel's literal `'ready'` file stays as is: it carries no record and its existence is the signal.
2. **One readiness helper, three predicates.** One async helper in the custody test file polls at 50ms until a deadline. Callers pass a predicate:
   - leaf: `child-ready.json` parses to a record with numeric `pid` and string `birth` (returned to the caller);
   - sentinel: the `sentinel-ready` file exists;
   - start output: `stdout.log` contains `fixture-begin\n`.
     On each poll the readiness predicate is evaluated first, then the fail-fast conditions.
3. **Deadlines.** Leaf readiness: 5000ms measured from `start()` return (max observed 1799ms, about 2.8x margin). A following `fixture-begin` wait shares that same deadline (max 82ms after readiness). Sentinel readiness: 2000ms from sentinel spawn (max 183ms, about 11x). Worst-case budgets, longest observed test plus one exhausted deadline: 10.6s + 5s = 15.6s; observer case 9.5s + 2s + 5s = 16.5s. Both fit the unchanged `20_000` test bounds.
4. **Fail-fast conditions and causes.** For invocation-scoped waits, each poll checks `existsSync(<invocation>/result.json)` (`terminal-published`; the owner publishes it by rename, and existence alone is checked) and `process.kill(ownerPid, 0)` throwing `ESRCH` (`owner-absent`; any other error is not absence and the wait continues). The sentinel wait runs before any invocation exists: its fail-fast condition is the sentinel's own exit, observed as `observeProcess(identity.pid) !== identity.birth` using the identity `startSentinel` returns (`sentinel-exited`); the fixture API is not widened. Deadline expiry with no condition met fails with `readiness-deadline`. Every failure message starts with the fixed cause token, followed by the existing sanitized `terminalEvidence` when an invocation exists; the birth-checked identity observation runs at most once, on failure. A Darwin owner zombie still answers `kill(pid,0)`, which only delays fail-fast and never fails falsely; the helper must not switch to a group observation.
5. **Fail-fast regression.** A new `CustodyMode`, `early-exit`, makes the leaf exit 23 before publishing readiness. Its test calls the leaf-readiness helper after `start()` and expects:
   - rejection with cause `terminal-published` or `owner-absent`;
   - elapsed time under 5000ms and never `readiness-deadline`;
   - the status terminal `failed`, `command: {exitCode: 23, signal: null, settled: true}`, `interruption: 'none'`, `cleanup.state: 'confirmed'`.
     RED: with today's default 1s `vi.waitFor`, the same test fails with a generic timeout message and no cause token. GREEN: it gets a cause-marked fast failure.

# Must preserve

- `recordedGroupMember` reading (`trusted-docker-fixture.ts:208-213`) and the teardown order (`:504-526`, member before group).
- Sentinel file name and content (`:331`, `:335`), consumed at test `:280`.
- Every `observeProcess` birth assertion (`:252`, `:310-313`, `:378`, `:402`, `:431`) and every other assertion; `20_000` test bounds and 10s status waits; no `scripts/` change; no unconditional retry.

# Sibling surfaces

- `group-member.json` (`:159`): made atomic (decision 1), because teardown reads it even after an early failure.
- `fixture.start()`'s own bounded `child.json` wait (10s) and observer publication wait (15s): unchanged.
- `trusted-docker-audit.integration.test.ts`: not touched (see Non-goals).

# Non-goals

- The custody rejection cases at `:181-189` and the `DOCKER_HOST`/`DOCKER_CONTEXT` `it.each` at `:191-205` and the `trusted-docker-audit.integration.test.ts` selected-dispatch `it.each`, both on Vitest's default 5000ms _test_ timeout. The audit case is the #325 Darwin 8-concurrent residue (2/8 rounds, noted on this issue). These are test-duration bounds, not readiness waits; they are reported, not changed.

# Verification (input → expected)

- `early-exit` regression: RED with a generic 1s timeout before the change; GREEN with a cause-marked failure in under 5000ms after it.
- Darwin: `pnpm test:integration platform/test/trusted-docker-custody.integration.test.ts`, three sequential runs plus four concurrent runs over at least 3 rounds → all pass.
- Linux container (`node:24.13.1-bookworm --init --cpus 4 --user node`, pnpm via `npm -g`): the same command without `-t`, 4 concurrent and 6 concurrent + 8 burners, at least 10 rounds per tier → zero readiness-stage failures. Any other failure is listed individually, and per-test durations are reported against the 20s bound.
- Canonical checks; exact-head trusted custody `pnpm test:docker` and standalone `pnpm test:deploy` (branch protection).
