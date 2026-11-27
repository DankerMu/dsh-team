# Lifecycle observations name their phase, and the aggregate ones get measured bounds

## Why

Issue #749 was found during #736's acceptance band. Line numbers are for main `71cf68d`.

- **The failure.** A full `pnpm test:integration` run, started at 1-minute load 45.99, failed one case: `instance-lifecycle.integration.test.ts` › "canonical dev stop retains captured source-main ownership …". It took 14321 ms and ended with `Error: HTTP peer observation did not settle`. The message carries no label, so the failure cannot be attributed. The other 4 loaded runs passed.
- **Which observation timed out is unknown.** `observeHttp` (`gateway-http-fixture.ts:256`) appends `: <label>` only when a label is passed. No call in this file passes one. The cleanup steps (`:338`, `:345`) and `:563` (20 s) are ruled out; `:277`, `:514`, `:538`, `:551`, `:555` and `:568` remain.
- **The 2 s default has no measured basis here.** `HTTP_OBSERVATION_MS = 2000` rests on #687's single-event measurement (at most 87 ms in 4 other files, run alone at load 68–84). That measurement did not cover `instance-lifecycle`.
- **Two observations are aggregates, not single events.**
  - `:538` waits for a run of background requests from the freshly started main to the fake Engine.
  - `:551` waits for the whole `pnpm --dir <root> run dev:bg` child, from spawn to exit (`command()`, `:192-208`).
  - Both use the 2 s default.
  - Inferred, not proven: `:551` is the likeliest site. It is a pnpm, Node and bash start-up that exits 1 at the lock.
- **The ledger.** The case's `OWNERSHIP_CASE_MS = 160_000` ledger (`:486-491`) counts each of these as 2 s.

## What Changes

The issue's recommended option.

- **Labels.** Every `observeHttp` call in this file gets a unique phase label, for example `restarted dev:bg exit` or `start readiness reached`. That covers the case (`:493-573`), `runDevLifecycle` (`:245-379`) and the file's other calls (`:116`, `:122`, `:131`, `:133`, `:148`, `:161`, `:809`). Explicit timeouts are unchanged.
  - A scenario-phase stall fails the case with `HTTP peer observation did not settle: <label>`.
  - The cleanup sites (`:338`, `:345`) run inside `step()` (`:324-332`). They report the label in the case error's `cause` (`:375-378`), with that step `failed` in the facts.
- **Measurement.** The instrumentation is temporary and removed before commit.
  - **Wide bound.** Every observation in the case and in `runDevLifecycle` gets a 60 s bound, as #687 measured, so that a slow site is recorded instead of cut off at 2 s.
  - **Recording.** Each settle time is taken with `performance.now()` around the await and buffered in memory. After the case, one line per observation (label, ms, run start load) is appended to a scratchpad file outside the repository. The setup span, everything before the registration, is recorded the same way.
  - **Runs.** At least 5 counted full `pnpm test:integration` runs, each started at 1-minute load ≥ 13 and < 67, with bounded `yes` generators.
  - **Discarded runs.** A run started outside the band is discarded. So is an in-band run that goes red for another reason, but its samples are still recorded and reported.
- **Fit rule.** Let `x` be a site's measured maximum.
  - **Default-bound scenario sites** (`:538` readiness, `:551` restart).
    - If `x × 10 > 2000`, the site gets a named bound of `x × 10`, rounded up to 500 ms.
    - Otherwise it keeps the default.
    - Either way, a comment beside the site states its basis: band, runs, maximum, and the multiple against its bound.
  - **Explicit-bound sites** (`:514`, `:555`, `:563`, `:568`, `:338`) are measured and reported. Any literal under `10 × x` is reported, not changed. `:345` is not reached on the canonical pass path, which stops the main first, so it is reported as not measured.
  - **`:277`** (Engine listening, inside the unbounded setup and shared by the induced cases) is measured and reported only, never refitted.
- **Ledger.**
  - Each refitted site's 2 s in the `OWNERSHIP_CASE_MS` ledger (`:486-491`) is replaced by its bound.
  - The change goes ahead only if `(sum of the code bounds after refit) + (setup maximum measured in these runs) < 160_000`.
  - Otherwise, stop and ship labels only, with the issue's acceptance item 2 reported as open. The budget is never raised.
- **Unchanged.** `HTTP_OBSERVATION_MS`, `HTTP_SEND_MS`, `gateway-http-fixture.ts`, `scripts/dev-server.sh`, every assertion and every other file.

`design.md` is omitted because this is the compact level: one test file, with labels and measured constants.

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent (override: none upstream; compact because the change is confined to one integration test file)
Blast radius: instance-lifecycle.integration.test.ts only
Selected risk packs: Resource limits (deadlines under load); Error handling (attributable stall messages)
Evidence floor: red probe per labelled site in this case and runDevLifecycle; measurement record; 5 consecutive loaded full pnpm test:integration runs; pnpm lint, pnpm typecheck
```

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `integration-test-budgets`: the instance lifecycle case's observations name their phase, and its aggregate observations get measured bounds.

## Impact

- `platform/test/instance-lifecycle.integration.test.ts`.
