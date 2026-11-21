# Observer reserve sampling

## Why

`platform/test/deployed-docker-observer.integration.test.ts > isolates same-authority process generations with predecessor uncertainty=true` failed under load (macOS, load ~40) at `:478`. The assertion `expect(await readdir(pending)).toEqual(pending)` is meant to prove that a rejected `reserveVerificationDockerObserver` writes no pending marker. It samples the whole `SUBMISSION_PENDING` directory before (`:476`) and after (`:478`) the rejected reserve. With stalls=true the first-generation child is still alive and, 200 ms after its stalled `POST /networks/create` aborts on its own clock, legitimately writes a `DELETE /networks/owned-effect` submission marker (`:463-465`; `scripts/verification-submissions.mjs:141-147`). The parent only waits for the first request (`dispatched`, `:442`; `deployed-docker-observer-fixture.ts:309-315`), so the DELETE marker can land between the two samples: `[…(3)]` vs `[…(2)]`, no marker named. Product observer behaviour is correct (`scripts/verification-docker-generations.mjs:328-330` throws before any write). Introduced in `6ff889b`. Issue #655.

## What Changes

- With stalls=true, `beforeRelease` first waits until the stub server has received both the `POST /networks/create` and the `DELETE /networks/owned-effect` request (a request-count resolver in the server handler), then asserts the first sample is exactly the participant, POST and DELETE markers, so both samples observe a quiescent child: the DELETE marker is written before its request leaves, its response is held by `bound` (released only after `beforeRelease`), POST and DELETE aborts are not `DockerHttpError` and never settle, and `finish()` runs only on a zero exit. The wait races the child's exit (the fixture's existing `observed.closed` pattern) and fails at once with the request list and stderr, adding no deadline.
- `:478`'s failure message names every added or missing marker id with its `observer` field.
- The `beforeRelease` oracle becomes one test-local helper taking `quiescent()` and `sample()`, used by the real case and a separate deterministic regression case. In the regression case the child first issues a GET (an observation: no marker) that the stub server holds; the oracle's first observable action opens that gate. With the fixed order (`quiescent()` first) both samples see three markers; with the old order (`sample()` first) the DELETE marker lands between the samples and the case fails deterministically. The red run against the old order is PR evidence only; the old oracle is not kept in the repo.
- Spec: a requirement that a rejected observer reservation leaves the submission journal unchanged.
- Nothing else: no change to the 200 ms abort, any wall-clock deadline, sleeps/retries, product scripts, or the assertions at `:498`, `:517-535`, `:555-562`; stalls=false unchanged.

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent
Blast radius: a wrong synchronisation point could deadlock the case (no deadline added) or weaken the "rejected reserve writes nothing" proof
Selected risk packs: Concurrency / shared state / ordering
Evidence floor: deterministic red→green regression; the file repeated; 5 full pnpm check runs under load ≥ 13 with load and result recorded; exact-head VPS lane (platform/test change)
```

`design.md` is omitted (level compact).

## Capabilities

### Modified Capabilities

- `trusted-docker-verification`: adds the rejected-reservation journal invariant.

## Impact

`platform/test/deployed-docker-observer.integration.test.ts` and, if the resolver or gate lives there, `platform/test/deployed-docker-observer-fixture.ts`. Out of scope: wall-clock budgets (`startObserverChild` `timeout: 5000`), the 200 ms value, product `scripts/verification-*.mjs`, the `profile-seed` flake.
