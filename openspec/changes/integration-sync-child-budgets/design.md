# Design

## Context

`spawnSync` blocks the worker's event loop, so vitest's case timer cannot fire during it. Vitest 5 checks the deadline only after a case resolves (`run.C5UmxDPh.js:3277-3286`); a rejected case reports its own error (`:3290-3296`). If a child ignores SIGTERM, `spawnSync` stays blocked past its `timeout`, because the call waits for the child to exit. The verifier behind #1 and #4 traps SIGTERM (`scripts/verify-browser-runtime.mjs:292-303`). So the only bound that can expire first is the child's own timeout delivered with an uncatchable signal, and only if that timeout is the cut.

## Decisions

- **One primitive, unchanged messages.** Each child runs through `caseBudget(deadline).run(phase, file, args, options)` (`trusted-docker-fixture.ts:129-156`).
  - Its existing message `"<phase>: killed at the case deadline after <n>ms"` stays byte-identical, because `trusted-docker-custody.integration.test.ts:639` anchors it with `$`.
  - Extra attribution, such as live descendants, goes in the site fixture's own wrapping error or in `error.cause`, never as a suffix to that message.
  - If `caseBudget` gains a kill-signal option, its default is unchanged for its existing `run` callers (`trusted-docker-fixture.ts:355,392,436,608`), and `custody:639,640,660,686` keep passing.
- **The cut always applies.** At these sites the child's own `timeout` default is set to at least the case budget (for example `CASE_MS`), so `min(default, deadline − now − RESERVE_MS)` is always the cut and `caseBudget` always attributes it.
  - Every timeout at these sites uses `killSignal: 'SIGKILL'`.
  - The limit is computed immediately before each spawn. `RESERVE_MS` covers that case's later spawns, awaits and assertions.
  - Sequential children share one deadline, so each later child takes what remains: #2's warm-up, its audit-fixture helpers and the writer; #1's verifier and then the finalizer.
- **Descendants.** At #1, only the verifier's `docker.mjs` stand-in can outlive a SIGKILL: in `deadline` mode it never exits (`browser-build-fixture.ts:55`).
  - The stand-in records its own pid and start identity in a fixture-owned log.
  - After a cut, the fixture identity-checks each recorded pid, reports which are still alive, and kills only those that match.
  - Nothing else is promised. At #4 no descendant is observed, and the error says "descendants: not observed".
- **Red/green.** A temporary change makes one sync site's child complete normally but take longer than `CASE_MS`.
  - Before the fix: a bare `Test timed out in 5000ms`.
  - After: the cut message plus the site's attribution.

  The temporary change is not committed.

## Sibling surfaces

In scope, because they are the same family:

- `trusted-docker-audit-fixture.ts` `freshSubmissionAssessment` (`:32-46`), `ordinarySubmission` (`:61-84`) and `withAuditReceipt` (`:119-138`);
- the finalizer in `browser-build-fixture.ts:126-130`.

Other `*.integration.test.ts` files that run sync children are recorded as verdicts in the PR, not changed. The requirement is scoped to the four suites.
