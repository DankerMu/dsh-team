## Why

Issue #312 records one full local integration failure of `canonical dev stop retains captured source-main ownership …` with only `Timed out waiting for source-main ownership` retained; the start command result, phase timing and cleanup outcome were lost, so the cause stays UNKNOWN.

An authorized bounded diagnosis (2026-10-23, main `1ea697b`, Darwin) used a temporary phase overlay that was later removed (restored SHA256s `0e5c71dc…`/`9d9b967a…` verified). It measured the initial `dev:bg` time until a PID is published:

- 0.75s when run alone;
- 1.07s inside one full integration;
- 1.80–1.82s inside three concurrent full integrations.

Every run stayed far below the 5000ms wait; the full summary is in `.run/issue312/load-diagnosis.json`. There was no recurrence, so no cause is established and no deadline change is justified.

What is missing is evidence on the failure path. If this timeout recurs, the error must say which boundary was not reached:

- start entry/lock;
- the nested web build;
- main spawn / PID publication;
- an early command exit;
- a PID that was published and then cleared.

It must also report each cleanup outcome separately from the first failure.

## What Changes

- The initial ownership wait keeps the same predicate (`pidAt(.run/dev.pid)` valid), the same 5000ms/20ms bound, the same order, and the same leading error text. On timeout, the error additionally carries a bounded, sanitized evidence object built only from closed-set facts:
  - the command's state, exit code, signal and relative close time;
  - the first-observed relative time of the private root's lock directory, built web `index.html`, main log file and a valid PID;
  - the final pidfile state.
- The scenario's `finally` cleanup records each step's outcome independently. The first scenario failure stays primary, and cleanup failures are attached rather than replacing it.
- `scripts/dev-server.sh` stays byte-identical, and no raw output, environment, cookie or log content is retained.

## Impact

- Code: `platform/test/instance-lifecycle.integration.test.ts`, test-only.
- No production, script, deadline, predicate or cleanup-order change.

## Triage

```text
Issue type: test (verification diagnosability)
Fixture level: expanded
Upstream suggested level: absent (expanded: process lifecycle ordering, partial-failure cleanup composition and evidence secrecy)
Blast radius: a wrong change could hide the original failure behind cleanup errors, leak private log/env content into test output, alter the ownership predicate/deadline, or orphan a main process.
Selected risk packs: Error handling / partial outputs; Concurrency / ordering; Auth / permissions / secrets; Legacy compatibility
Evidence floor: pnpm check:fast; pnpm test:integration platform/test/instance-lifecycle.integration.test.ts (repeated); RED-before/GREEN-after for the induced held-preflight and failed-preflight evidence cases
```
