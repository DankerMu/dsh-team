## Risk packs

- Error handling / rollback / partial outputs — **selected**: the diagnostic appears only on failure and must not replace the original assertion or lose the timing to tail truncation; tasks 1.3–1.5.
- Concurrency / shared state / ordering — **selected**: timing capture runs inside the engine handler and the child call path; it must not delay the response, change request order or the stall cancellation; tasks 1.1, 1.2, 2.1, 2.2.
- Auth / permissions / secrets — not selected: the child `env` is the literal `{PATH, LANG}` (`deployed-docker-observer-fixture.ts:262`); request bodies are not included (method/path only); child stderr is already printed today as the assertion message.
- Resource limits — covered by the 8192-character tails (1.3).
- Public API, Config, File IO, Schema, Legacy, Release, Documentation — not selected: no such surface.

## Must preserve

- `AbortSignal.timeout(200)` at the create call and the stall branch's real cancellation (`deployed-docker-observer-fixture.ts:585-590`).
- Child assertions `:591-595`, stdout markers, `stderr === ''` on success, the `requests` sequence assertion (`deployed-docker-observer.integration.test.ts:178-187`), `persisted`/`markersBeforeBinding`/closed-connection assertions, compiled-evidence assertions.
- `platform/test/e2e-engine-fixture.py:414-427` copy list: the formatter stays in `deployed-docker-observer-fixture.ts` (already listed); no new fixture module.
- No change to `platform/src/orchestrator/client.ts`, `scripts/verification-submissions.mjs` or any production file.

## 1. Diagnostics

- [ ] 1.1 Engine fixture: for the create path record `received`, `bodyEnded`, `responseFinished` (`finish`) and `responseClosed` (`close`) from `process.hrtime.bigint()` as milliseconds; `dispatchedSettled` where `dispatched.resolve` is called. Create a `monitorEventLoopDelay` histogram when the fixture is created, enable it, and expose `maxEventLoopDelayMs` plus a disable step called when the scenario settles. No added awaits; handler statement order unchanged.
- [ ] 1.2 Child source, non-stall branch only: `called` before the call, `const pending=client.json(...)`, `issued` immediately after, `created=await pending` in the existing try; `settled` in the catch. When `failure !== undefined`, write exactly one line `create-timing:{"called":…,"issued":…,"settled":…}\n` to stderr before `assert.equal(failure,undefined)`. Stall branch keeps its original single-expression call.
- [ ] 1.3 One exported formatter in `deployed-docker-observer-fixture.ts` builds the JSON diagnostic: `childTiming` parsed from the first `create-timing:` line of the **full** stderr (or `null`), `engine` fields from 1.1 (`null` for absent times) plus `persisted`, `markersBeforeBinding.length`, `requests` as `METHOD path`, and `stdout`/`stderr` tails (last 8192 chars, marker exactly `[truncated: <n> earlier characters omitted]`). The test at `:170` passes it as the assertion message; criterion unchanged.
- [ ] 1.4 Formatter cases: (a) no engine receipt → `received: null`, `persisted: false`; (b) stderr of 10000 characters whose first line is `create-timing:…` → `childTiming` still parsed and stderr tail carries `n=1808`; (c) no timing line → `childTiming: null`. Exact field assertions. RED must be an assertion failure on content, not an import/type error.
- [ ] 1.5 Required real-child case: run `observerScenarioSource({ stalls: false, containerMode: false, … })` against `createObserverEngineFixture({ stalls: true, … })` (no change to the shared fixture's default behaviour), so the real 200ms abort and the real exit path occur. Launch with `runObserverChild(reserved, source, { bind: false })` — no `bindingGate`/`releaseResponse` — because this child exits ~200ms after the abort with no later request holding it alive, so a late parent bind would hit a gone process (precedent `deployed-docker-observer.integration.test.ts:503`). After the child exits, `await observation.stalledConnectionClosed` before building the diagnostic (child exit and engine socket close are unordered). Assert structurally only: child exit code 1; the diagnostic's `childTiming` parses with `called <= issued <= settled`; engine `received` present; `persisted` and `dispatchedSettled` true; `responseClosed` a number and `responseFinished === null`. **No** timing-precision assertion (`settled - called` is reported, not asserted; if a lower bound is ever added it must be loose, e.g. ≥ 190, and labelled non-precision). Clean up all fixture resources as the existing cases do.

## 2. Verification

- [ ] 2.1 `pnpm test:integration platform/test/deployed-docker-observer.integration.test.ts` — the three existing it.each cases pass unchanged; new cases RED then GREEN (record both).
- [ ] 2.2 Run the observer file 5× locally to show no new instability from the timing capture.
- [ ] 2.3 `pnpm check:fast`, `pnpm lint:tests`, `pnpm dead-code`, `pnpm duplicate-code`.
- [ ] 2.4 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, CI green.

## Non-goals

- Fixing #343 or changing the 200ms deadline.
- Separating transport time from child-side asynchronous work before the engine's receipt beyond what `issued`, `received` and the worker's event-loop delay show; attributing a cause.
- CI artifact upload or workflow changes.
