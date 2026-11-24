## Risk packs

- **Concurrency / shared state / ordering — selected.** Vitest's timer does not run while `spawnSync` blocks. The cut child timeout with `SIGKILL` must be the bound that expires first, computed immediately before the spawn. Tasks 1.1-1.3.
- **Resource limits / cleanup — selected.** A SIGKILL can orphan descendants. They are reported and retired through the existing ownership-checked cleanup. Task 1.2.
- **Not selected:** error handling and partial outputs (assertions unchanged; attribution only appended), all product surfaces, config, auth and secrets (attribution excludes output, env and paths), release.

## Acceptance-criteria mapping

- **AC1** (explicit budgets; inner waits strictly below them, derived) → partial: the sync sites #1, #2, #4, #8 and their same-helper cases, tasks 1.1-1.3. #3, #5 and #6 are in the second change.
- **AC2** (attributed timeouts; red→green) → partial: sync waits, tasks 1.2, 1.4. Async waits are in the second change.
- **AC5** (loaded runs) → partial: these files, evidence 2.1. The second change repeats it for its files.
- The PR uses `Refs #656`. The issue closes with the second change.
- **AC6** (no retry, skip or assertion change) → must preserve.
- **AC3** (#7) and **AC4** (comments) → the second change.

## Must preserve

- Every existing assertion's content, including the message regexes and the canary and secret absence checks (#1 `:97-98`, #4 `:13`, `:56`). No retry, skip or narrowed include.
- Product and script semantics (`scripts/*.mjs`, `platform/src/**`).
- `caseBudget`'s existing messages byte-identical (`custody:639` anchors one with `$`). Its existing `run` callers (`trusted-docker-fixture.ts:355,392,436,608`) and `custody:639,640,660,686` keep passing, and their default kill signal is unchanged.
- `vitest.config.ts` concurrency.

## 1. Implementation

- [x] 1.1 Every case in `browser-build.integration.test.ts`, `trusted-docker-audit.integration.test.ts` (#2 and the five sibling cases), `ci-vps-proxy.integration.test.ts` and `profile-seed.integration.test.ts` (both cases) declares a named `CASE_MS` with its basis.
- [x] 1.2 Every synchronous child of these suites runs through `caseBudget(deadline).run`:
  - the verifier and finalizer in `browser-build-fixture.ts`;
  - the spawn in `ci-vps-proxy-fixture.ts`;
  - the writers and warm-up in `trusted-docker-audit.integration.test.ts`, and the `freshSubmissionAssessment`/`withAuditReceipt` helpers in `trusted-docker-audit-fixture.ts`;
  - both cases' `python3` in `profile-seed.integration.test.ts`.

  How each child is bounded:
  - its default timeout is at least the case budget, so the cut always applies;
  - every timeout uses `killSignal: 'SIGKILL'`;
  - the limit is computed immediately before each spawn, minus a stated `RESERVE_MS`;
  - sequential children share the case deadline.

  Two things stay as they are:
  - `caseBudget` messages are unchanged; site attribution goes in the site's wrapping error or `cause`;
  - a helper keeps its default meaning when no deadline is passed.

  At #1 the `docker.mjs` stand-in records its pid and start identity in a fixture-owned log. After a cut the fixture identity-checks each recorded pid, reports the live ones and kills only the matching ones. #4 reports "descendants: not observed".

- [x] 1.3 Record a verdict, in the PR, for any other `platform/test/*.integration.test.ts` case found to inherit 5 s around a synchronous child (`grep -n spawnSync`). Do not change those cases here.
- [x] 1.4 Red→green at one sync site with a child that completes normally but slower than `CASE_MS`. Before the fix: bare `Test timed out`. After: the cut kill with its attribution. Record both texts in the PR. The temporary slow child is not committed.

- [x] 1.5 Fix pass 1:
  - the stand-in tolerates a failed `processBirth` (it records `birth: null`, which is reported as `unobservable` and never killed), so recording never changes a build;
  - committed tests for `caseSpawn`: the cut always applies, SIGKILL is used against a SIGTERM-trapping child, the reserve is honoured, and the message and `cause` are shaped correctly;
  - committed tests for `retireDescendants`: alive/killed, gone, reused/retained and unobservable;
  - a failing descendants callback keeps the cut message;
  - `ordinarySubmission` returns to its original form, because no budgeted case calls it;
  - stale comments are fixed.

## 2. Verification

- [x] 2.1 Five full `pnpm test:integration` runs with 1-minute load ≥ 13, using bounded load generators that are stopped afterwards; record the load and result of each. Also `pnpm check`.
- [x] 2.2 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, with confirmed cleanup.
