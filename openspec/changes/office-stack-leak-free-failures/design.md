# Design

Change surface: `withWorkFiles` (`sidebar-archive-stack-fixture.ts:236-254`), reached by 11 call sites (4 inside `retiringOnError`, editor B nested in the editor lane, 6 unwrapped); new `expectFreeOf` in `stack-browser-fixture.ts`; `officeForgotten` checks (`office-forgotten-stack-fixture.ts:454`, `:476`); any assertion the sweep (#3) changes in `platform/test/*-stack-fixture.ts`.

Must preserve:

- `withWorkFiles` success: runs `run`, then cleanup, returns `run`'s value; a cleanup failure after a successful lane propagates (it is the only failure).
- `withWorkFiles` lane-only failure: the lane's error is rethrown as the same object (identity), so `retiringOnError`, `clearingForgottenOnError` and `office-editor-stack-fixture.integration.test.ts`'s `rejects.toBe(lane)` keep working, and a `StackWorkbenchFailure` stays one with its scrubbed evidence.
- Existing `stack-verification` scenarios: "Office stack double failures report every scrubbed cause and hold nothing raw" (lane plus retirement, session plus close, close only), "Stack workbench failures carry no document key or query", "A stack session failure folds each cause once".
- One scrub implementation (`scrubbedChain`/`scrub`/`redactSecrets` in `stack-browser-fixture.ts`); no new scrubber.
- The forgotten lane's checks keep their meaning: they fail exactly when the JSON contains `kA`.

Must add/change:

- Lane plus cleanup failure → `Error` (not `AggregateError`), message = fixed `${label} lane and cleanup failed` text followed by both scrubbed reasons, no `cause`, no `errors`.
- Forgotten checks → boolean form.
- Sweep (#3) per proposal.

Governing invariant: a `withWorkFiles` double failure, and any failure of an assertion in the swept files, holds no unscrubbed document key, JWT or URL query in its message, own properties, cause or members. The same-name DOCX aggregate is excluded (see Non-goals).

Sibling surfaces:

- `retiringOnError` (`office-editor-stack-fixture.ts:299-312`): already plain; when it wraps a `withWorkFiles` double failure, the inner plain error is scrubbed text, so folding it again prints each reason once (the existing "each reason once" scenario).
- `clearingForgottenOnError` (`document-server-forgotten-fixture.ts`): rethrows as is; unchanged.
- `StackWorkbenchFailure` and the workbench close path (`stack-browser-fixture.ts`): unchanged.
- `platform-stack.stack.test.ts` top-level rethrow: unchanged.
- `sameNameFailure` (`office-editor-stack-fixture.ts:418`): stays an `AggregateError` with raw members by the main requirement "同名 DOCX 失败给出每一侧的原因"; non-goal, recorded as a known limitation.

Seams under test: `withWorkFiles` directly with a stand-in `ArchiveLane`; `archiveScenario` (unwrapped) and `retiringOnError(() => withWorkFiles(...))` (wrapped, as the editor lane does); `expectFreeOf` directly (both forgotten sites call it, so the seam covers them); `everythingPrinted` from `stack-browser-fixture.ts` for "nothing raw".

Required evidence:

- #1: lane failure message `lane /doc/<64-hex kA>/c/?x`, cleanup failure message containing a second 64-hex key; retirement succeeds. Thrown: `not.toBeInstanceOf(AggregateError)`, no `cause`, no `errors`; message `toBe(\`${label} lane and cleanup failed [${scrub(laneMessage)}; ${scrub(cleanupMessage)}]\`)`(the`retiringOnError` precedent's format), each reason occurring exactly once (`message.split(reason).length === 2`); `everythingPrinted(error)`contains neither key. Run through`archiveScenario`(unwrapped, label`Sidebar archive`) and through `retiringOnError(() => withWorkFiles(...))`(wrapped). Red before: the thrown value is an`AggregateError` whose members print the raw keys.
- #2: `expectFreeOf({ listed: [`doc/${kA}/x`] }, kA, 'positive control free of A key')` throws; its message and `everythingPrinted` contain no `kA` but contain the label; `expectFreeOf({ listed: [] }, kA, …)` passes. Red before: write the helper first with the old body (`expect(JSON.stringify(value), label).not.toContain(secret)`), record the case red (printed `Expected`/`Received` carry `kA`), then switch to the boolean body.
- #3: each changed site reachable from an existing unit seam gets a no-echo case (red before where the old form echoed); the rest are listed in the PR's change/keep table.
- Lane-only failure through `withWorkFiles` still rejects with the same object (`rejects.toBe`).
- `pnpm test:integration`; one local `pnpm test:stack` on the final head; VPS `pnpm test:docker` + `pnpm test:deploy`.

Non-goals: wrapping single-failure rethrows; widening `scrub`'s token coverage; the same-name DOCX aggregate; the `knowledge-*`/`ragflow` stack fixtures; product code.

Review focus:

- No path through `withWorkFiles` returns or throws raw text on a double failure; identity on single failure.
- The sweep's kept sites are justified.
- Each reason printed once when `retiringOnError` folds a `withWorkFiles` double failure.
