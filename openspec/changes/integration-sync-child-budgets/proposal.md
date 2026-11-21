# Integration sync-child budgets

## Why

The integration project has no `testTimeout` (`vitest.config.ts:23`), so a case without a third argument inherits vitest's 5000 ms. Four families of cases wait on a **synchronous** `spawnSync` whose own `timeout` (5-10 s) is not derived from that budget. A blocking `spawnSync` stops vitest's timer, so under load the full local `pnpm check` (the exact-head merge gate) fails intermittently with an unattributable `Test timed out in 5000ms`, while CI passes. Same root cause as #628/#630. Issue #656, first of two slices. This slice covers the synchronous-child sites; the async-wait sites #3, #5, #6, #7 and the stale #630 comments follow in a second change.

Sites (lines on `main` d6e6e6f, identical to be168db):

- **#1:** `browser-build.integration.test.ts:79-100` and the 12 other cases in that file that call `runBrowserBuildFailure`. All of them reach `browser-build-fixture.ts:208-219` `spawnSync(verifier, { timeout: 10_000 })` with the default SIGTERM. The verifier (`scripts/verify-browser-runtime.mjs:292-303`) traps SIGTERM and keeps running its own cleanup. The rescue cases also run the 10 s finalizer at `:126-130`.
- **#2:** `trusted-docker-audit.integration.test.ts:699-817`, plus the five cases at `:145-214`, `:216-298`, `:300-404`, `:427-465`, `:467-603`. Each waits on a `spawnSync` writer with `timeout: 5000`, equal to the case budget, and #2 also runs a warm-up first. The cases also run the `trusted-docker-audit-fixture.ts` helpers `freshSubmissionAssessment` and `withAuditReceipt`, each a sync spawn with a fixed `timeout: 5000`.
- **#4:** `ci-vps-proxy.integration.test.ts:4`, `:16`, `:59`. These reach `ci-vps-proxy-fixture.ts:198-207` `spawnSync(…, { timeout: 10_000 })` with the default SIGTERM.
- **#8:** `profile-seed.integration.test.ts:281-370`, a synchronous case, and the `it.each` at `:236-279`. Both run `spawnSync('python3', …, { timeout: 10_000, killSignal: 'SIGKILL' })`.

## What Changes

- **Explicit budgets.** Every case above declares its budget as a named constant, with the basis for the number (cold Node/Python starts, the verifier's own cleanup).
- **Reuse `caseBudget`, with its messages unchanged.** Each synchronous child runs through the existing `caseBudget(deadline).run` primitive (`platform/test/trusted-docker-fixture.ts:129-156`), with no second implementation. `run` cuts the child's `timeout` to the remaining case budget, computed immediately before the spawn, minus a stated reserve. The reserve covers every await after the spawn: reads, cleanup, and vitest's post-resolve deadline check (`node_modules/vitest/dist/chunks/run.C5UmxDPh.js:3277-3286`).
- **The cut always applies, with an uncatchable kill.** At these sites the child's default timeout is at least the case budget, so the cut always applies. Every timeout uses `SIGKILL`, because a `spawnSync` returns only after its direct child exits. At #1, the only descendant that can survive, the `docker.mjs` stand-in, records its pid and identity in a fixture-owned log. After a cut it is identity-checked, reported, and killed if it matches.
- **Attribution.** The cut message names the phase and the elapsed milliseconds. The site's own wrapping error, or `error.cause`, adds the live recorded descendants, or says "not observed". Neither carries child stdout or stderr, environment values or paths. A synchronous child is always reaped by the time it returns, so its own liveness is not reported. Existing message regexes and canary or secret absence checks still hold.
- **Spec.** A new capability `integration-test-budgets` states the rule for the synchronous children of the four suites, behind `constraints.yaml` `testing.integration_deadline_from_case_budget`. The second change extends it to the async-wait sites.

No retry, skip or assertion change. Product and script semantics are unchanged (`scripts/*.mjs`, `platform/src/**`). A test fixture may accept an injected deadline without changing its default's meaning. No `vitest.config.ts` concurrency change.

The PR refers to the issue with `Refs #656`, not `Closes`. The issue stays open until the second change merges.

## Triage

```text
Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: a wrong cut turns a slow pass into a false failure; SIGKILL can orphan a verifier's descendants (reported, cleaned by the existing fixture owners); attribution must not leak canaries/secrets
Selected risk packs: Concurrency / shared state / ordering (blocking spawnSync vs vitest timers; kill signals; descendants); Resource limits / cleanup (orphaned descendants after SIGKILL)
Evidence floor: red→green on a sync site with a child that completes normally but slower than the case budget (before: bare `Test timed out`; after: cut kill with attribution); each family's cases green; 5 full loaded `pnpm test:integration` runs (load ≥ 13) with load and result; pnpm check; exact-head VPS lane
```

## Capabilities

### New Capabilities

- `integration-test-budgets`: integration cases wait only inside an explicit case budget and fail attributably.

## Impact

These files under `platform/test/`: `browser-build.integration.test.ts`, `browser-build-fixture.ts`, `trusted-docker-audit.integration.test.ts`, `trusted-docker-audit-fixture.ts`, `ci-vps-proxy.integration.test.ts`, `ci-vps-proxy-fixture.ts`, `profile-seed.integration.test.ts`, and possibly `trusted-docker-fixture.ts` (if `caseBudget` gains a kill-signal option) or a move of `caseBudget` to a shared fixture. Moving it means a verbatim move with its callers updated, never a copy.

Out of scope, handled in the second change: #3 `egress-capture`, #5 `chrome-start`, #6 `instance`, #7 `document-server-net-script`, the stale #630 comments, and the three sibling fixtures (`main-startup-fixture.ts:120`, `onlyoffice-token-fixture.ts:80`, `ci-vps-worker-fixture.ts:149`).
