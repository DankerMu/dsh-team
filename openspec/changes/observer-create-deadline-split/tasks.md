## Risk packs

- **Concurrency / shared state / ordering (selected).** Synchronous submission work against a timer that is already running. Covered by probe 1.1a.
- **Error handling (selected).** A stall-case failure must carry the child's timing. Covered by probe 1.1b.
- **Not selected:** file IO, public API, config, secrets, resource limits, release, docs, legacy compatibility. The change touches only the test fixture's deadline and its diagnostics.

## Must preserve

- Every case criterion listed in the proposal under Unchanged: no retry, no skip, no loosened assertion.
- The stall case's 200 ms real cancellation. The engine writes only `'{'`.
- `stderr === ''` and the exact stdout for a passing case.
- `scripts/verification-*` and `platform/src/orchestrator/client.ts` are unchanged.
- The `:278` case keeps `code: 1`, a non-null `childTiming` with `called <= issued <= settled`, and engine `received` set, `persisted: true`, `responseClosed` set and `responseFinished: null`. Its abort now fires at 2000 ms.
- The `:213-276` formatter unit cases are unchanged.

## 1. Implementation

Write each probe first and record its red output against the unchanged fixture, then change the fixture.

- [x] 1.1a Non-stall probe. Add a test-only option to `observerScenarioSource` that binds the create's deadline signal to a variable, busy-waits for more than 200 ms, and only then calls `client.json(…, signal)`. The delay therefore runs after the deadline exists and before the request is written. Run the non-stall case with this option. Before the change it is red with `ABORT_ERR`, engine `received: null` and `requests: []`. After the change it is green.
- [x] 1.1b Stall attribution probe. Write a dedicated committed test modelled on `:278`, not an `it.each` row: the stall source with the same injected delay, so its 200 ms abort fires before the request is sent. It asserts `code: 1, signal: null`, a non-null `childTiming` with `called <= issued <= settled`, and `engine.received: null`. Before the change it is red with `childTiming: null`.
- [x] 1.2 Split the create deadline: 2000 ms for non-stall cases, with a comment citing #746 and 212 ms; 200 ms kept for the stall case. Add the stall-path timing and attribution.

## 2. Verification

- [x] 2.1 `pnpm exec vitest run --project integration platform/test/deployed-docker-observer.integration.test.ts`, `pnpm test:integration`, `pnpm lint`, `pnpm typecheck`, `pnpm dead-code`, `pnpm duplicate-code`: exit 0.
- [ ] 2.2 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`.

## Acceptance mapping (#746)

- The non-stall create deadline no longer covers `submit()`'s synchronous work, and the reason is written down with the 212 ms evidence: tasks 1.1a and 1.2.
- The stall case keeps real cancellation (only `'{'`, an error that is not a `DockerHttpError` and has no `cause`, one pending marker, `unconfirmed`): the unchanged `it.each` stall row (`:67-200`) and Must preserve.
- The stall case's create failure carries `called`, `issued` and `settled`: task 1.1b.
- The criteria are unchanged, with no retry and no skip: Must preserve.
- The file passes locally and `pnpm test:integration` passes in CI: tasks 2.1 and 2.2, plus CI.
