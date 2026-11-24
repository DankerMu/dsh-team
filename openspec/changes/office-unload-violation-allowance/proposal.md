# Office unload violation allowance

## Why

Issue #671, decision (b). Line numbers are on main `200ed94`. Measurement and decision are in the issue comment of 2026-11-23.

- **Chromium 158 breaks the Office stack lanes.** With Playwright 1.65 (#670), ONLYOFFICE 9.4.0 reports `Permissions policy violation: unload is not allowed in this document.` as a console error in every Document Server editing session. The report comes when `unload` is registered, about 0.3–1 s after the editor config arrives, not when the session closes. The lanes' exact console-error allowlists reject it:
  - hints: `serviceWorkerRefused` (`office-hints-stack-fixture.ts:117`, checked at `:407`). The measuring run 1 failed here.
  - editor and rewrite: `editorErrorsAllowed` (`office-editor-stack-fixture.ts:157-163`).
  - `openHinted`'s own collector (`office-hints-stack-fixture.ts:168-170`) feeds the same matchers while waiting for the §48 refusal.
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

- **One classifier in `stack-browser-fixture.ts`:** `documentServerUnload(text, location, origin)`. It returns the source as `<script path after the version segment>:<line>` when all of these hold:
  - the text is the exact violation text;
  - the location's origin is the platform's;
  - its path is the mount with version `9.4.0` followed by one of the five measured scripts;
  - its line is that script's measured line.

  Otherwise it returns `undefined`. The table lives next to it, with a comment naming #671 and the user decision.

- **`workbenchSession` moves allowed reports out of `consoleErrors`.** Its console handler puts each allowed report's source into a new list, `StackBrowserEvidence.unloadViolations`. Every other error stays in `consoleErrors` as today, so each lane's existing exact matcher is unchanged and still rejects an unknown source.
- **`openHinted`'s collector** drops allowed reports through the same classifier, so its §48 wait sees what `consoleErrors` will hold.
- **Evidence:**
  - `scrubbedEvidence` maps the new list like the others.
  - Every Office evidence line that counts a session's lists also counts `unloadViolations`. These are `counted` in the editor fixture, which the editor and idle lines use, and the rewrite and hints lines' session summaries.
  - `StackWorkbenchFailure`'s counts prefix is unchanged.
- **Docs.** The `platform/test/README.md:92` evidence contract and `docs/LOCAL_STACK.md` § Office rows state the allowance, its source table and the decision.
- **Not changed:**
  - the §48 ServiceWorker matcher, the §51.2 AI plugin allowance and every other lane matcher;
  - product code and the Playwright version. The bump stays #670's, which then runs `pnpm test:stack` on 1.65 (#671 AC5).

## Triage

```text
Issue type: test (verification lane allowance, user-decided)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: every stack browser session's console handling (StackBrowserEvidence gains a field); Office lanes' console matchers see the allowed reports removed; evidence lines gain a count
Selected risk packs: Contract / compatibility (StackBrowserEvidence shape, evidence lines); Error handling (an unknown-source violation must still fail the lane)
Evidence floor: classifier cases (each measured source allowed; wrong text, origin, version, path, line and a missing location rejected); workbenchSession and openHinted stand-in cases that route an allowed report to unloadViolations and keep an unknown-source one in consoleErrors; mutants per design.md; pnpm check; exact-head pnpm test:stack (Chromium 153: zero allowed reports) and VPS lane
```

## Capabilities

### Modified Capabilities

- `stack-verification`: Office editing sessions allow the measured Document Server `unload` reports by source.

## Impact

- `platform/test/stack-browser-fixture.ts` and its integration test.
- `platform/test/office-hints-stack-fixture.ts` (`openHinted`, the hints line), `office-editor-stack-fixture.ts` (`counted`), `office-rewrite-stack-fixture.ts` (its session line), plus the integration tests whose evidence literals gain the field.
- `platform/test/README.md:92`, `docs/LOCAL_STACK.md`.

## Risk packs

- **Contract / compatibility — selected.** `StackBrowserEvidence` gains a required field, so every literal in the tests gains it. The evidence lines change only by the new count. Tasks 1.2, 1.4.
- **Error handling — selected.** A report from any other source, line or version stays a console error and fails the lane as today. Tasks 1.1, 1.3.
- **Not selected:** secrets (a source is a fixed script path and a line, with no key or query; the hash segment is dropped), product, concurrency.

## Must preserve

- Every other console error reaches `consoleErrors` unchanged, in order.
- The §48 and §51.2 matchers and every lane's assertions, apart from the evidence literals gaining the field.
- On Chromium 153 (main's Playwright 1.63) no report is allowed, so `unloadViolations` is empty and every lane behaves as today.

## Acceptance-criteria mapping (#671)

- **AC1** (the hints session's mode and when the violation is reported) → done by measurement, recorded in the issue.
- **AC2** (product impact of leaving without saving) → done by measurement: no impact.
- **AC3** (the user's decision recorded; for A, integration cases cover allowing and rejecting) → this change, 1.1–1.3. The decision is source-bound rather than "at most once": the measured counts are 2–4 per session, and the user chose no count limit.
- **AC4** (same-name failure detail) → done in #706, partly.
- **AC5** (`pnpm test:stack` green on Playwright 1.65) → after this merges, on #670's rebased exact head.
