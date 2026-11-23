# Office same-name DOCX failure detail

## Why

Issue #671, the ready part: its evidence gap. Line numbers are on main `6c9d195`.

- **The failure hides its reasons.** `sameNameDocx` runs A's and B's editing sessions at once. When either side rejects, it throws `new AggregateError(failures, 'Office editor same-name DOCX failed')` (`platform/test/office-editor-stack-fixture.ts:425-430`). The vitest report shows only that outer message.
- **The cost.** On the Playwright 1.65 run of #670 the lane failed after both browsers showed "all changes saved". Finding the inner failure (`editorErrorsAllowed` at `:350`, with a third console error) took a temporary local patch and a second run of about six minutes.
- **A safe line already exists.** `scrubbedChain` (`stack-browser-fixture.ts:119-127`) already folds a cause chain into one scrubbed line for `StackWorkbenchFailure`. The inner failures vary (a `StackWorkbenchFailure`, an assertion over scrubbed lists, a closed gate, a docker command failure carrying argv and stderr, `Office editor save not observed`), so the new outer message is made only of fixed labels and `scrub` output, whatever the inner message holds.

## What Changes

- **`scrubbedChain` is exported** from `stack-browser-fixture.ts`, unchanged. No second chain walker is added.
- **The same-name failure names each failed side.** An exported helper `sameNameFailure(a, other)` builds it from the two settled results, so a one-sided failure can be tested directly. The message becomes `Office editor same-name DOCX failed: A: <chain>; B: <chain>`, with only the sides that rejected, in A-then-B order. Each `<chain>` is `scrubbedChain` of that side's rejection reason, so the inner text is scrubbed a second time. Scrubbing is idempotent: its replacements yield only `<redacted>` or the kept path, never a new `/`, `?`, `#`, long run or 64-hex run, so a `StackWorkbenchFailure` message passes through unchanged.
- **Kept:** the error stays an `AggregateError` and `errors` keeps each rejected side's reason as it is, A's first. The gates' `fail` calls, the `withWorkFiles` wrapping and the success path are unchanged.
- **Not changed: `retiringOnError`** (`:295-309`). When B's retirement also fails, its fixed message `Office editor lane and retiring B failed` again hides the same-name message. It is shared by the editor, forgotten, external and idle lanes and is a separate failure event, so it is reported as an out-of-scope finding, not changed here.
- **Not in this change:** the rest of #671. That is the Chromium 158 measurement and the user's decision on the `unload` violation (option A or B1–B3), which come in a later PR.

## Triage

```text
Issue type: test (failure diagnostics)
Fixture level: minimal
Upstream suggested level: absent
Blast radius: the Office editor lane's same-name failure message only; the AggregateError's errors, every success path and evidence line keep their behaviour
Selected risk packs: Auth / permissions / secrets (the new message text must keep every key and query out, as #663 requires)
Evidence floor: an integration case red before the change (message without the inner text) and green after; the existing #663 leak cases still pass over the new message; pnpm check; exact-head pnpm test:stack and VPS lane
```

## Capabilities

### Modified Capabilities

- `stack-verification`: the same-name DOCX failure states each side's scrubbed reason.

## Impact

- `platform/test/stack-browser-fixture.ts`: one `export` keyword.
- `platform/test/office-editor-stack-fixture.ts`: the failure at `:425-430` moves into an exported helper `sameNameFailure`, the seam for the one-sided cases.
- `platform/test/office-editor-stack-fixture.integration.test.ts`: assertions on the outer message.

## Risk packs

- **Auth / permissions / secrets — selected.** The outer message now holds inner text. The existing #663 cases already walk the whole error tree, the outer `AggregateError` included, with `everythingPrinted`, and must keep passing. Tasks 1.2, 1.3.
- **Not selected:** concurrency (the two sides' order in the message is fixed by `Promise.allSettled`'s order, not by timing), product code, docs.

## Must preserve

- The `AggregateError` class and its `errors` array: each rejected side's reason, unchanged, A's first.
- The success path, the gate failure handling and every evidence line.
- `scrubbedChain`'s behaviour and `StackWorkbenchFailure`'s message.

## Acceptance-criteria mapping (#671)

- **AC4** (a `sameNameDocx` failure shows each side's scrubbed inner text in the vitest report, proven by an integration case) → 1.1–1.3, 2.1–2.2, **partly**. Two nested paths still show only a fixed outer message, and both are reported as out-of-scope findings:
  - B's retirement also fails: `retiringOnError` wraps the lane failure in `Office editor lane and retiring B failed` (`office-editor-stack-fixture.ts:295-309`);
  - a side's session and its `browser.close` both fail: that side rejects with `AggregateError('Stack workbench … and browser close failed')` (`stack-browser-fixture.ts:327-328`), which has no `cause`, and `scrubbedChain` walks only `.cause`, so that side's `<chain>` is the fixed text. The stack run shows it only when the lane fails; on main it passes, so 2.2 proves no regression and the runtime proof comes from the Playwright 1.65 measuring run in #671's next step.
- AC1–AC3 and AC5 stay open in #671.
