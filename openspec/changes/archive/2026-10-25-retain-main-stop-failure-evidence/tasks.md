## Risk packs

- Error handling / rollback / partial outputs — **selected**: the change composes a stop failure with the earlier observation outcome; tests 1.1–1.4 prove neither is lost or relaxed.
- Public API / CLI / script entry — not selected: test fixture only; `observeStartup` signature and return type unchanged.
- Auth / permissions / secrets — not selected: the child `env` is an explicit literal (`main-startup-fixture.ts:118-129`) with loopback/temp-path values only and no `process.env` spread, so no CI secret reaches the child; its raw stderr is already printed today (`main-startup-fixture.ts:81`, consumers' `JSON.stringify(result)` at `subnet-startup.integration.test.ts:9`). Deliberately differs from the closed-set sibling rule (#312) for that reason; see proposal.
- Concurrency / shared state / ordering — not selected: stop still runs after observation in the same `finally`; ordering unchanged (1.4 asserts afterExit still runs only after a successful stop).
- Resource limits / large input — covered by 1.2 (bounded stderr tail).
- Config / setup, File IO, Schema, Legacy compatibility, Release, Documentation — not selected: no such surface touched.

## Must preserve

- `stopMainProcess` sends SIGTERM only when the child is still alive (`requested`), and fails iff `requested && (code !== 0 || signal !== null)`.
- Spawn options (`timeout: 6000`, `killSignal: 'SIGKILL'`, `PLATFORM_LOG_LEVEL: 'silent'`, stdio), all deadlines, and `options.afterExit` ordering (runs only after a successful stop, as today).
- Consumers `platform/test/subnet-startup.integration.test.ts` (9 calls) and `platform/test/quarantine-bootstrap.integration.test.ts:42` pass unchanged with no assertion edits.
- Production `platform/src/main.ts` untouched.

## 1. Diagnostics

- [x] 1.1 Extract the observation-plus-stop combination (today `observeStartup`'s `finally` at `main-startup-fixture.ts:165-170` plus `stopMainProcess`) into **one exported function that `observeStartup` itself calls**; add `platform/test/main-startup-fixture.integration.test.ts` driving that function with real short-lived `node -e` child processes (no mocks of `ChildProcess`). RED on current source must be an assertion failure on message content (e.g. message lacks `code=1`), not an import/type error — land the export first if needed.
- [x] 1.2 Stderr in the message is the last 8192 characters of captured stderr; when longer, prefixed by exactly `[stderr truncated: <n> earlier characters omitted]`. Tests: a child printing 10000 characters then exiting 1 after SIGTERM → message contains the marker with n=1808 and the final characters; a short stderr appears whole with no marker.
- [x] 1.3 Stop failure after a fulfilled observation: `error.message` contains `code=1`, `signal=null`, the stderr text, and the observation's health status and exitCode. Stop failure after a rejected observation: `error.message` names code/signal and `error.cause` is the identical original error object. Child ended by signal (child SIGKILLs itself on SIGTERM): message contains `signal=SIGKILL`.
- [x] 1.4 Success paths unchanged: code 0/no signal returns the observation; a child already exited before stop is not signalled and does not throw; an observation error with a successful stop is rethrown as the same error object.
- [x] 1.5 Implement in `platform/test/main-startup-fixture.ts` only; keep the criterion and spawn options byte-identical.

## 2. Verification

- [x] 2.1 `pnpm test:integration platform/test/main-startup-fixture.integration.test.ts` RED (assertion failure on message content) before the diagnostic change, GREEN after (record both).
- [x] 2.2 `pnpm test:integration platform/test/subnet-startup.integration.test.ts platform/test/quarantine-bootstrap.integration.test.ts` pass.
- [x] 2.3 `pnpm check:fast` (fmt, lint, typecheck) and `pnpm lint:tests`/`pnpm dead-code` pass (test-only exports must be consumed).
- [x] 2.4 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy` (required gate), CI green.

## Non-goals

- Fixing the #342 failure or attributing its cause (remains UNKNOWN until a recurrence retains this evidence). The evidence separates exit classes (silent nonzero / error dump / signal), not source lines.
- Changing log level, deadlines, retries or the graceful-stop criterion; CI artifact upload.
