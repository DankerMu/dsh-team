# Why

Several readiness waits in `platform/test/trusted-docker-custody.integration.test.ts` rely on Vitest's default 1000ms `vi.waitFor` timeout and on bare file existence (issue #324). Under heavy CPU contention the leaf's `child-ready.json` arrives late: measured Linux p99 1676ms, max 1799ms at 6 concurrent suites plus 8 CPU burners, and 97.8% of samples exceeded 1s (#324 comment 6371840383). The test then fails before reaching the custody behavior it exists to verify, which masks real defects such as #321. The leaf also writes `child-ready.json` non-atomically, and a Darwin 4-concurrent run once observed it existing but empty (1/288), making the following `JSON.parse` throw. The sentinel and `fixture-begin` waits never exceeded 52ms from their wait start. They share the same default-timeout pattern, but they fail only if the wait order changes.

# What Changes

- One bounded readiness wait in the custody test replaces each default-timeout readiness `vi.waitFor`. It uses an explicit deadline derived from the measurement: 5000ms for leaf readiness, with `fixture-begin` sharing that deadline from `start()` return, and 2000ms for sentinel readiness. On every poll it fails immediately, with the existing sanitized terminal evidence, if the invocation has already published `result.json` or the owner process is gone (`ESRCH`).
- The fixture leaf publishes `child-ready.json` and `group-member.json` atomically (private `.pending` file, then rename, the pattern already used by inline fixture scripts such as `browser-wrapper-docker-fixture.ts`). Leaf readiness also requires a parseable record with a numeric `pid` and string `birth`.
- Failures name one fixed sanitized cause (`terminal-published`, `owner-absent`, `sentinel-exited` or `readiness-deadline`) ahead of the existing terminal evidence.
- No assertion, product (`scripts/`) deadline or test bound (`20_000` per test, 10s status waits) changes.

See `design.md`.

# Capabilities

## Modified Capabilities

- `trusted-docker-verification`: custody regressions wait for readiness through a bounded, fail-fast signal.

# Impact

`platform/test/trusted-docker-custody.integration.test.ts`, `platform/test/trusted-docker-fixture.ts`. No production source, workflow or dependency change.

# Triage

Issue type: test
Fixture level: expanded
Upstream suggested level: absent (expanded: atomic file publication and concurrent readiness ordering in a shared verification fixture; no product surface)
Blast radius: flaky or masked custody regressions; an over-long bound could exceed the 20s test budget
Selected risk packs: concurrency/shared state/ordering; resource limits/deadlines; error handling/partial outputs
Evidence floor: RED/GREEN of a new early-exit fixture mode proving fail-fast with a cause marker; canonical checks; full-file (no `-t`) loaded runs — Linux container 4 concurrent and 6 concurrent + 8 burners, Darwin 4 concurrent — with zero readiness-stage failures and every other failure listed; exact-head trusted custody `pnpm test:docker` and standalone `pnpm test:deploy` (branch protection)
