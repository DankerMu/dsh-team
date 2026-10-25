## Why

#342: in CI run 40199052224 attempt 1 (head `2f80a26`), `subnet-startup.integration.test.ts > does not listen while the real owner reconciliation is held at the Engine boundary` failed with only `Main did not settle through graceful shutdown` (`platform/test/main-startup-fixture.ts:48`). Attempt 2 passed; the cause is UNKNOWN. The failure retained nothing attributable:

- the error omits the child's actual `exit.code`/`exit.signal`;
- it is thrown from `observeStartup`'s `finally` (`main-startup-fixture.ts:166-169`), so it replaces the main observation (health, exitCode, captured stderr) or the observation's own error;
- the child runs with `PLATFORM_LOG_LEVEL=silent`, so `main.ts:58-65`'s shutdown-rejection path (exit 1) writes no stderr, while the startup-throw path (`main.ts:82-86`) prints an uncaught error. Code, signal and stderr are needed together to tell these apart from signal termination.

## What Changes

Diagnostics only, in the shared test fixture `platform/test/main-startup-fixture.ts`:

- The graceful-stop failure **message** (the text CI prints) carries the actual `code` and `signal` and the last 8192 characters of the child's already-captured stderr, prefixed by `[stderr truncated: <n> earlier characters omitted]` when longer.
- When the stop fails after the observation, the same message also carries the fulfilled observation (`health` status, `exitCode`; its stderr is the same stream already included); a rejected observation is kept as the thrown error's `cause` (Vitest prints it as "Caused by"). The stop failure still fails the test; an earlier observation error is never swallowed.
- The combination of observation outcome and stop is one exported function that `observeStartup` itself calls, so the new test exercises the real code rather than a copy.

What this evidence can and cannot tell apart: (code, signal, stderr) separates three exit classes — a silent nonzero exit (e.g. the `main.ts:58-65` shutdown-rejection handler under `silent` logging), a nonzero exit with an uncaught error dump (e.g. `main.ts:82-86` startup throw, or `main.ts:88` `closeRuntime()` rejecting), and signal termination. It does not identify a source line; if a recurrence cannot be classified, the conclusion stays UNKNOWN.

Raw stderr in the message deliberately differs from the closed-set rule of the sibling requirement "Background start ownership verification retains safe timeout evidence" (`built-artifact-verification`): this child's `env` is an explicit literal (`main-startup-fixture.ts:118-129`) that does not spread `process.env`, so CI secrets never reach it, and its raw stderr is already printed today by `main-startup-fixture.ts:81` and by consumers' `JSON.stringify(result)` (`subnet-startup.integration.test.ts:9`).

Unchanged: the `requested` precondition, the `code !== 0 || signal !== null` criterion, SIGTERM semantics, spawn `timeout: 6000`/`SIGKILL`, `PLATFORM_LOG_LEVEL=silent`, every deadline, every consumer assertion, production `main.ts`. No retry, skip or lengthened deadline. The historical failure stays UNKNOWN; this change does not claim a fix.

## Triage

```text
Issue type: test
Fixture level: compact (one shared test fixture's failure branch; no production, entrypoint, schema or format change)
Upstream suggested level: absent (issue is needs-triage; only the diagnostic slice is implemented here)
Blast radius: every observeStartup consumer (subnet-startup 9 calls, quarantine-bootstrap 1); a wrong change could mask the original failure, swallow an observation error or relax the graceful-stop criterion
Selected risk packs: Error handling / rollback / partial outputs
Evidence floor: pnpm test:integration platform/test/main-startup-fixture.integration.test.ts (new, RED on message content then GREEN), pnpm test:integration platform/test/subnet-startup.integration.test.ts platform/test/quarantine-bootstrap.integration.test.ts, pnpm check:fast
```

`design.md` omitted at compact level. The #312 sibling was `expanded` because it changed a lifecycle command's timeout reporting and cleanup composition across several processes; this change is one failure branch of one test fixture with no ordering or signalling change, so `compact` holds.

Spec home: `built-artifact-verification`, next to the #312 source-main ownership-evidence requirement, not `http-shutdown` (production shutdown behavior is unchanged).
