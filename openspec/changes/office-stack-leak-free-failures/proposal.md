# Office stack double failures from withWorkFiles and the forgotten lane's key assertions print no raw key

## Why

Issue #735, left over from #717 (PR #731). Line numbers refer to main `3f7ba75`.

1. **`withWorkFiles` double failure is a raw aggregate** (`platform/test/sidebar-archive-stack-fixture.ts:236-254`, from #430 `4de08f1`).
   - When the lane fails and cleanup also fails, it throws `new AggregateError([error, cleanup], \`${label} lane and cleanup failed\`)` (`:248`). Its members are the raw errors, not passed through `scrubbedChain`.
   - 11 call sites. Four run inside `retiringOnError` (`office-editor-stack-fixture.ts:299-312`), which rethrows the aggregate unchanged when the retirement succeeds (`:310`): editor `:520`, forgotten `office-forgotten-stack-fixture.ts:510`, external `office-external-stack-fixture.ts:242`, idle `office-idle-stack-fixture.ts:217`. Editor B (`office-editor-stack-fixture.ts:444`) is nested inside the editor lane. Six have no retirement wrapper, so the aggregate leaves directly: sidebar archive `:261`, legacy preview `:237`, hints `:431`, isolation `:358`, profile `:194`, rewrite `:858`. `platform-stack.stack.test.ts` then rethrows a single failure as is.
   - vitest 5.0.2 prints a top-level aggregate member by member, so an unscrubbed document key in either member reaches the report.
2. **The forgotten lane's leak checks print the key they guard** (`office-forgotten-stack-fixture.ts:454`, `:476`, from #624 `c055ea2`). `expect(JSON.stringify(positive), …).not.toContain(kA)` and the same for `present`. `kA` is A's real 64-hex document key. On failure vitest prints `Expected: "<kA>"` and `Received: "<JSON with kA>"`. `clearingForgottenOnError`, `withWorkFiles` and `retiringOnError` rethrow it unchanged.
3. **Single-failure rethrows do not scrub**, so a clean report depends on each source. Item 2 is one source that does not scrub. The issue recommends fixing sources, not wrapping the rethrow points (wrapping would break `StackWorkbenchFailure`'s evidence contract, `office-editor-stack-fixture.integration.test.ts`'s `rejects.toBe(lane)`, and `clearingForgottenOnError`'s "rethrow as is" contract).

## What Changes

- **#1.** `withWorkFiles`'s lane-plus-cleanup failure becomes one plain `Error`, as in `retiringOnError`: `new Error(scrubbedChain(new AggregateError([error, cleanup], \`${label} lane and cleanup failed\`)))`. It has no `cause`and no`errors`, and its message carries the fixed text and both scrubbed reasons. Single-failure behavior is unchanged: a lane failure alone is rethrown as is, and a cleanup failure alone (lane succeeded) propagates as is.
- **#2.** A new helper `expectFreeOf(value: unknown, secret: string, label: string)` in `stack-browser-fixture.ts` asserts `expect(JSON.stringify(value).includes(secret), label).toBe(false)`, so a failure prints only `expected true to be false` and the label. Both forgotten-lane checks call it (`expectFreeOf(positive, kA, 'positive control free of A key')`, same for `present`). The helper is the seam: reaching `:454`/`:476` through `officeIsolationWithForgotten`'s stand-in would need a dozen stubs.
- **#3, source sweep.** Files: `legacy-preview-stack-fixture.ts`, `office-editor-stack-fixture.ts`, `office-external-stack-fixture.ts`, `office-forgotten-stack-fixture.ts`, `office-hints-stack-fixture.ts`, `office-idle-stack-fixture.ts`, `office-isolation-stack-fixture.ts`, `office-profile-stack-fixture.ts`, `office-rewrite-stack-fixture.ts`, `sidebar-archive-stack-fixture.ts` (all in `platform/test/`; the `knowledge-*` and `ragflow` stack fixtures are out of scope). Every `expect(…)` there is classified by where its printed parts come from: the actual value, the expected value **and the message argument**.
  - **Change** when any printed part is built from lane data that can carry a document key, JWT or URL query: page, DOM or URL state; console or network records; Document Server or `docker`/`exec` output; admin configuration read back. Change it to a form that does not echo it: `expectFreeOf`, a boolean or count comparison, or a message passed through `scrub`/`redactSecrets`/`scrubEach`. Known instances: `office-hints-stack-fixture.ts:200`, `:205` (`seen = JSON.stringify(final)`), `office-external-stack-fixture.ts:147`.
  - **Keep** constants, booleans, counts, digests, and values already passed through `scrub`/`redactSecrets`/`scrubEach`.
  - Deliverable: a per-`expect` change/keep table in the PR description, one line of reason each.

## Triage

```text
Issue type: test-infrastructure bugfix (report-time redaction leak)
Fixture level: expanded
Upstream suggested level: absent (shared helper withWorkFiles has 11 call sites; secrets in reports)
Blast radius: platform/test Office/sidebar stack fixtures and their integration tests; failure reports of the local full-stack lane; no product code
Selected risk packs: Auth / permissions / secrets; Error handling; Legacy compatibility
Evidence floor: red-before/green-after integration cases (#1 through archiveScenario and through retiringOnError(withWorkFiles); #2 through the expectFreeOf helper, red with the old body first, then the boolean body; #3 no-echo cases where a unit seam reaches a changed site); pnpm test:integration; one local pnpm test:stack on the final head; exact-head VPS pnpm test:docker + pnpm test:deploy
```

## Capabilities

### Modified Capabilities

- `stack-verification`: the double-failure requirement also covers a lane plus its work-file cleanup. A new requirement says real-lane leak assertions never print the secret they guard.

## Impact

- `platform/test/sidebar-archive-stack-fixture.ts` and its integration test; `office-forgotten-stack-fixture.ts` and its integration test; any other `*-stack-fixture.ts` the sweep changes, with their tests.
- Out of scope: wrapping single-failure rethrow points (rejected in the issue); the scrubber's coverage of short tokens (`scrub` in `stack-browser-fixture.ts`); the same-name DOCX failure (`sameNameFailure`, `office-editor-stack-fixture.ts:418`), which the main spec requirement "同名 DOCX 失败给出每一侧的原因" keeps as an `AggregateError` with the raw per-side failures in `errors`. On a single failure it reaches the top level as an aggregate whose members vitest prints. Changing it contradicts that requirement, so it is recorded as a known limitation (work summary) rather than changed here. In a double failure `reason()` drops members already named, so each side prints once.
