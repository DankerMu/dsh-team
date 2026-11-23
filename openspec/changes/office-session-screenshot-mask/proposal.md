# Office session screenshot mask

## Why

Issue #681. Line numbers are on main `28c5547`.

dsh-sidebar-onlyoffice 0.2.0 shows the staleness guard's raw message in the 「保存未写回文件」 notice above the editor. That message holds the editing session's document key, the file path, and the expected and actual size and mtime. The stack lane's screenshots are full-page `page.screenshot` calls (`stack-browser-fixture.ts:256-262`). Text redaction (#663) cannot reach pixels. `platform/test/README.md` requires the Office evidence to carry no key.

Two sessions show this notice by design, and their screenshots are unmasked:

- **Rewrite `rewriteCase`** (`office-rewrite-stack-fixture.ts:464`, `names` without `masked`, passed at `:468`):
  - The `unsaved` case expects the notice from the Agent rewrite until the save lands (`EXPECTED_REWRITE.unsaved`).
  - Its failure screenshot (`<shot>-failure`, taken by the shared fixture on a throw) and its `-saved` screenshot can show it. `heldWithin` returns `false` on a timeout instead of throwing, and `-saved` is still taken.
  - `clean` goes through the same call; a regression that shows the notice there is equally unmasked.
- **Forgotten edit session** (`office-forgotten-stack-fixture.ts:328-355`):
  - It deliberately trips the guard. `:345` presses the forcesave and `:347` takes `office-forgotten-edit-typed` 3 s later.
  - The latest local stack run on main (`reports/stack/13657bbc…/office-forgotten/office-forgotten-edit-typed.png`) shows the notice in the normal, passing path.
  - At the 1280 px viewport the bar's text is cut off after the fixed label, so the guard message was not legible there. Whether it is legible depends on width and message length, so this is still a leak path.

The shared fixture already has the session-level `masked` option (PR #680, `stack-browser-fixture.ts:63`, `:259-261`). It masks every screenshot of the session, the failure screenshot included, and the typing case uses it (`office-rewrite-stack-fixture.ts:599-602`). The plugin renders `{t('saveFailed')}: {saveError}` in one `<span>` (0.2.0 `OnlyOfficeView.tsx:358-360`); `getByText`'s substring match on the DOM text finds that span however the ellipsis truncates it, and the mask covers it, the only element holding the guard text. A non-zh page would match nothing and leave the span unmasked silently; the lane is zh-only (same as #680).

## What Changes

- **One notice definition.** `NOTICES` in `office-rewrite-stack-fixture.ts` is exported. The forgotten fixture imports it rather than copying the string. Neither module imports the other today, so no cycle is introduced (`pnpm lint:deps` checks it).
- **Rewrite:** `rewriteCase` passes `masked: [NOTICES.saveFailed]` in the `names` it gives `workbenchSession`, the same shape as the typing case, with the same one-line reason comment.
- **Forgotten edit:** `editIntoForgotten` passes `masked: [NOTICES.saveFailed]` in its `names`.
- **Tests:** through the existing `vi.mock('./stack-browser-fixture.ts')` seam, a stand-in records the `names` each `workbenchSession` call receives.
  - Rewrite: `officeRewriteScenario` with the existing `rewriteLane` stand-in; the recorded first session (`office rewrite clean`) has `masked` containing `NOTICES.saveFailed`. `clean` and `unsaved` share that one `names` expression.
  - Forgotten: `officeIsolationWithForgotten` with a stand-in lane that reaches `editIntoForgotten`; the recorded session `office forgotten edit` has `masked` containing `NOTICES.saveFailed`.
  - Both cases go red with `masked` removed (recorded in the PR).
- **Docs:** `platform/test/README.md:92` states the mask for the rewrite `clean`/`unsaved` screenshots and the forgotten edit session, as it already does for the typing case.
- **Excluded:** the editor, hints, external and forgotten recover sessions never have a refused save in their normal flow (issue § 受影响面, low risk). The typing case is already masked. Text-output redaction is #663. The plugin showing the guard text to the employee is upstream product behaviour (D1).

## Triage

```text
Issue type: bugfix (test secret hygiene, screenshot pixels)
Fixture level: standard
Upstream suggested level: absent
Blast radius: two stack-lane browser sessions' screenshots; masking hides only the notice element, every other pixel and every assertion unchanged
Selected risk packs: Auth / permissions / secrets (document key in screenshot pixels)
Evidence floor: stand-in names tests red without masked; touched integration files; pnpm check; exact-head local pnpm test:stack with the masked screenshots inspected; exact-head VPS lane
```

## Risk packs

- **Auth / permissions / secrets — selected.** The document key in screenshot pixels. Tasks 1.1–1.3, 2.2.
- **Not selected:** concurrency, config, product, migration.

## Acceptance-criteria mapping (#681)

- **AC1** (`rewriteCase` masks `NOTICES.saveFailed` for `clean` and `unsaved`) → 1.1.
- **AC2** (a committed stand-in case proves the rewrite and forgotten edit sessions' `names.masked` includes `NOTICES.saveFailed`, red without it) → 1.3.
- **AC3** (optional, local only: a forced failure while the notice shows, the failure PNG masked) → not done. `stack-browser-fixture.integration.test.ts:442-463` proves only that `mask` reaches every screenshot call, failure included, through a stub browser. The pixel proof is 2.2: `office-forgotten-edit-typed.png` shows the notice on the normal path, so after the fix it must show the masked block there. The PR says so.
- **AC4** (normal screenshot list and `EXPECTED_REWRITE` unchanged, the stack rewrite cases pass) → 2.1, 2.2.
- **AC5** (the forgotten edit session masked; the PR states whether `office-forgotten-edit-typed.png` showed the notice before the fix) → 1.2, 1.4, 2.2. Before: shown, text truncated at 1280 px (see Why).

## Must preserve

- `EXPECTED_REWRITE`, `EXPECTED_TYPING`, `officeRewriteLine` and the forgotten evidence, unchanged.
- Each session's screenshot names and count, unchanged.
- The notice-visibility observations (`NOTICES_SHOWN`, `NOTICES_SEEN`) read the DOM, not screenshots; masking must not change them.
