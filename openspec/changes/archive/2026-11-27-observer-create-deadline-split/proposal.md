# The observer's non-stall create no longer spends its deadline on synchronous submission work

## Why

Issue #746 is a recurrence of #343. The failure was seen in the CI of PR #744 (run 45746063148); this fixture does not reproduce it. Line numbers refer to main `46c07e9`.

- **One deadline for all three cases.** `platform/test/deployed-docker-observer-fixture.ts:561` builds the create call as `client.json('POST', …, AbortSignal.timeout(200))`. The three `it.each` cases in `deployed-docker-observer.integration.test.ts:67-82` share it: a stall case, a non-stall case, and a non-stall `containerMode` case.
- **The deadline starts before synchronous work.** The signal exists at the call site, but the observed client's `json` first runs `submit()` synchronously. `submit()` covers `requireClaim`, `reserveSubmission` (three `fsyncSync`), and the write up to `outgoing.end` (`scripts/verification-submissions.mjs:142-147`, `verification-docker-generations.mjs:556-570`, `verification-submission-storage.mjs:214-226`, `platform/src/orchestrator/client.ts:106-131`).
- **Measured on CI.** `issued − called` was 211.7 ms. On the first loop turn the expired timer aborted the request before connect, so the engine logged `received: null` and `requests: []`. Which synchronous step was slow was not measured.
- **The non-stall cases do not test cancellation.** Their criteria are `failure === undefined`, the request sequence and a `confirmed` assessment, so a 200 ms deadline protects nothing there. The stall case does test cancellation: the response stays incomplete and must be cancelled for real.

## What Changes

The issue's recommended option:

- **Non-stall cases.** The create uses the same `AbortSignal.timeout(2000)` as the scenario's other requests (`:613-628`). A comment cites #746 and the 212 ms measurement.
- **The stall case.** It keeps `AbortSignal.timeout(200)` and its real-cancellation semantics. It now records `called` / `issued` / `settled` the same way the timed path does.
  - **How a pre-send abort fails.** The abort makes `failure` a `DockerTransportError`, which passes the stall assertions (`:600-603`). The inspect `GET` then waits on `bound`, which is never released (`deployed-docker-engine-fixture.ts:96`, `deployed-docker-observer-fixture.ts:316-324`). The child rejects and exits non-zero, and the parent fails first at `deployed-docker-observer.integration.test.ts:121`. That check already attaches `formatObserverCreateDiagnostic`, whose `childTiming` is `null` today.
  - **Emission contract.** The stall child writes the existing `create-timing:` line only on a path that then ends in a non-zero exit, never at the expected create abort. This follows the write-then-throw precedent at `:609`, proven by the `:278` test. The parent picks the line up through the existing `childCreateTiming` (`:673`). The parent and the formatter are unchanged, and there is no new channel.
  - **Passing stall run.** It still writes no timing, so `stderr === ''` and its exact stdout hold.
- **Unchanged:**
  - every criterion: `code: 0, signal: null`, the exact stdout, `stderr === ''` on success, the full `requests` sequence, `failure === undefined` for the non-stall cases, and the stall case's error shape (an `Error`, not a `DockerHttpError`, with no `cause`), its single pending marker and its `unconfirmed` assessment;
  - no retry and no skip;
  - `scripts/verification-*` and `platform/src/orchestrator/client.ts`.

`design.md` is omitted: compact level. The change is one test fixture's deadline split plus attribution for the stall path.

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent (override: none upstream; compact because the change is confined to one test fixture and its integration test)
Blast radius: the three deployed-docker-observer create cases
Selected risk packs: Concurrency / shared state / ordering (synchronous work vs. timer); Error handling (attribution of the stall path)
Evidence floor: red probe for the non-stall case with injected synchronous delay > 200 ms before the request; stall-case attribution probe; pnpm test:integration; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `trusted-docker-verification`: "Observer create-deadline failures retain attributable timing evidence" now gives the non-stall create a 2000 ms deadline that no longer covers synchronous submission work, and makes stall-case failures carry the child's timing.

## Impact

- `platform/test/deployed-docker-observer-fixture.ts` and `platform/test/deployed-docker-observer.integration.test.ts`. This includes the existing `:278` case, "retains real create-deadline evidence when a non-stalling child create is aborted", whose real abort now fires at 2000 ms.
