# Office unload violation allowance

## Why

Issue #671, decision (b). Line numbers are on main `200ed94`. Measurement and decision are in the issue comment of 2026-11-23.

- **Chromium 158 breaks the Office stack lanes.** With Playwright 1.65 (#670), ONLYOFFICE 9.4.0 reports `Permissions policy violation: unload is not allowed in this document.` as a console error in every Document Server editing session. The report comes when `unload` is registered, about 0.3–1 s after the editor config arrives, not when the session closes. The lanes' exact console-error allowlists reject it:
  - hints: `serviceWorkerRefused` (`office-hints-stack-fixture.ts:117`, checked at `:407`). The measuring run 1 failed here.
  - editor, rewrite and idle: `editorErrorsAllowed` (`office-editor-stack-fixture.ts:161-167`).
  - `openHinted`'s own collector (`office-hints-stack-fixture.ts:168-172`) feeds the same matchers while waiting for the §48 refusal. The report can arrive before the two §48 refusals, and `serviceWorkerRefused` then never holds, so the wait times out.
- **Measured sources.** Each one is a Playwright `ConsoleMessage.location()` under the Document Server mount `/sidebar/onlyoffice/ds/9.4.0-<hash>/`, with a 0-based line:

  | script                                                         | line   | sessions                    |
  | -------------------------------------------------------------- | ------ | --------------------------- |
  | `web-apps/apps/documenteditor/main/app/controller/Main.js`     | 2145   | DOCX                        |
  | `web-apps/apps/spreadsheeteditor/main/app/controller/Main.js`  | 1785   | XLSX                        |
  | `web-apps/apps/presentationeditor/main/app/controller/Main.js` | 1638   | PPTX                        |
  | `sdkjs/cell/sdk-all.js`                                        | 465226 | XLSX, again on each refetch |
  | `sdkjs-plugins/v1/plugins.js`                                  | 39     | every editor                |

  DOCX and PPTX report 2 per load, XLSX 3. The hints session is an editing session (`mode=edit`, `isEdit=true`), so it reports too.

- **No product impact.** A DOCX that was typed into but not saved keeps the edit in three cases: the tab is closed (`runBeforeUnload: true`), the page navigates away, or the browser closes. The file holds the typed text within about 6.5 s, and no beforeunload dialog appears.
- **User decision (2026-11-23): option A, allowed by source.** Only the exact text is allowed, and only when its location is one of the measured Document Server 9.4.0 script lines. There is no count limit, and the evidence records each allowed report's source. The same text from any other source is still rejected. B3 (an upstream report) was declined.

## What Changes

- **One per-message classifier in `stack-browser-fixture.ts`:** `recordedError(message, origin)`. It takes a Playwright `ConsoleMessage` and returns one of three results:
  - `undefined` for a message that is not `error`-type;
  - `{ unload: '<script path after the version segment>:<line>' }` when all of these hold:
    - the text is exactly the violation text;
    - `location().url` is non-empty and its origin is the platform's;
    - its pathname is the mount with version `9.4.0` followed by one of the five measured scripts;
    - `location().line` is that script's measured line;
  - `{ error: text }` otherwise.

  The source table, `DS_UNLOAD_SOURCES`, lives next to it, with a comment naming #671 and the user decision.

- **Both console collectors call it and nothing else:**
  - `workbenchSession`'s handler (`stack-browser-fixture.ts:284-286`) puts `unload` results into a new list, `StackBrowserEvidence.unloadViolations`, and `error` results into `consoleErrors` as today. Each lane's exact matcher is unchanged and still rejects an unknown source.
  - `openHinted`'s collector (`office-hints-stack-fixture.ts:168-172`) keeps only `error` results, so its §48 wait sees what `consoleErrors` will hold.
- **Evidence prints each source.**
  - `counted` (`office-editor-stack-fixture.ts:170-173`) gains `unloadViolations: browser.unloadViolations`, the list itself, as `screenshots` is. That reaches the editor, rewrite (editor and agent sessions), idle and external lines, which all go through `counted`.
  - `officeHintsLine` (`office-hints-stack-fixture.ts:136-140`), which prints no list today, gains `unloadViolations` as well. Its "never the browser lists" test changes its contract to that one list.
  - Sources are fixed script paths with a line, the hash segment dropped. `scrub` leaves them unchanged, and `scrubbedEvidence` maps the list like the others.
  - `StackWorkbenchFailure`'s counts prefix is unchanged.
- **One lane assertion changes:** the read-back session's `counted(readBack)` `toEqual` (`office-editor-stack-fixture.ts:501-504`) expects `unloadViolations: []`. The read-back is a conversation and opens no Document Server.
- **Docs.** The `platform/test/README.md:92` evidence contract and `docs/LOCAL_STACK.md`'s Office rows state the allowance, its source table and the decision.
- **Not changed:**
  - the §48 ServiceWorker matcher, the §51.2 AI plugin allowance and every other lane matcher;
  - product code and the Playwright version. The bump stays #670's, which then runs `pnpm test:stack` on 1.65 (#671 AC5).

## Triage

```text
Issue type: test (verification lane allowance, user-decided)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: every stack browser session's console handling (StackBrowserEvidence gains a field); Office lanes' console matchers see the allowed reports removed; evidence lines gain the `unloadViolations` source list
Selected risk packs: Contract / compatibility (StackBrowserEvidence shape, evidence lines); Error handling (an unknown-source violation must still fail the lane)
Evidence floor: recordedError cases (each measured source allowed; extended, truncated text, other origin, version, path, line, empty URL and non-error type handled); workbenchSession and openHinted stand-in cases that route an allowed report out and keep an unknown-source one; mutants (a)-(f) per design.md, each red; pnpm check; exact-head pnpm test:stack (Chromium 153: no allowed report) and VPS lane
```

## Capabilities

### Modified Capabilities

- `stack-verification`: Office editing sessions allow the measured Document Server `unload` reports by source.

## Impact

- `platform/test/stack-browser-fixture.ts` and its integration test.
- `platform/test/office-hints-stack-fixture.ts` (`openHinted`, `officeHintsLine`) and its integration test, which gains a minimal stand-in page for `openHinted`.
- `platform/test/office-editor-stack-fixture.ts` (`counted`, the read-back assertion).
- The integration tests whose evidence literals or line expectations gain the field: editor, rewrite, idle, external, forgotten and hints.
- `platform/test/README.md:92`, `docs/LOCAL_STACK.md`.

## Risk packs

- **Contract / compatibility — selected.** `StackBrowserEvidence` gains a required field, so every literal in the tests gains it. The evidence lines change only by the new list. Tasks 1.2, 1.4.
- **Error handling — selected.** A report from any other source, line or version stays a console error and fails the lane as today. Tasks 1.1, 1.3.
- **Not selected:** secrets (a source is a fixed script path and a line, with no key or query; the hash segment is dropped), product, concurrency.

## Must preserve

- Every other console error reaches `consoleErrors` unchanged, in order.
- The §48 and §51.2 matchers and every lane's assertions. The exceptions are the evidence literals gaining the field and the read-back `toEqual` gaining `unloadViolations: []`.
- On Chromium 153 (main's Playwright 1.63) no report is allowed, so `unloadViolations` is empty and every lane behaves as today.

## Acceptance-criteria mapping (#671)

- **AC1** (the hints session's mode and when the violation is reported) → done by measurement, recorded in the issue.
- **AC2** (product impact of leaving without saving) → done by measurement: no impact.
- **AC3** (the user's decision recorded; for A, integration cases cover allowing and rejecting) → this change, 1.1–1.3. The decision is source-bound rather than "at most once": the measured counts are 2–4 per session, and the user chose no count limit.
- **AC4** (same-name failure detail) → done in #706. Two nested paths that still show a fixed outer message were reported there as out-of-scope findings.
- **AC5** (`pnpm test:stack` green on Playwright 1.65) → after this merges, on #670's rebased exact head.
