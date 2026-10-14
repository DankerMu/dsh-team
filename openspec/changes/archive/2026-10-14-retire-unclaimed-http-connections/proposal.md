# Proposal

## Why

Issue #228 blocks #92's real deployment failure-path acceptance: a platform-owned accepted TCP connection with no parsed HTTP request survives server shutdown after service and helper retirement have completed. An acknowledged zero-byte connection independently reproduces pending close; the client identity of the production connection remains unknown.

## What Changes

- Retire application-owned connections that have not produced a parsed HTTP request or upgrade when shutdown begins, including accepts racing the shutdown fence.
- Preserve already-admitted HTTP requests, partial bodies, normal response completion, gateway upgrades and service/activity/database drain ordering.
- Add deterministic actual-application TCP regressions for cold/incomplete-header retirement and admitted-work preservation, plus the existing deployment counterexample as integration evidence.
- No force-close-all setting, forced process exit, retry, deadline increase, DSH change or provider call.

## Capabilities

### New Capabilities

- `http-shutdown`: ownership-aware shutdown of accepted pre-request connections without interrupting admitted HTTP work.

### Modified Capabilities

None. The shared Epic fixture stays open; its gateway and instance invariants are preserved.

## Impact

Platform HTTP application lifecycle and focused tests; no route/schema, database migration, dependency or configuration change. Implement as a separate prerequisite to PR #227, then rebase/resume deployment acceptance without resetting its review gate. Fixture level expanded; high risk from concurrency, transport ownership and graceful retirement. Parent-inline fixture admission and implementation under higher single-mapped-slice delegation constraints are disclosed rather than reported as independent reviews; final acceptance uses independent high-risk reviewers and protected CI.
