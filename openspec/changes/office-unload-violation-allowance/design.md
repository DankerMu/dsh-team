# Design

## Decisions

- **Classify at the source of the list, not in each matcher.** The violation is filtered in two places: `workbenchSession`'s console handler and `openHinted`'s collector. Every lane matcher (`serviceWorkerRefused`, `editorErrorsAllowed`, the rewrite and forgotten checks) then keeps its exact shape. The alternative was adding the text to each matcher. That means five matchers, each with its own count rule, and none of them sees the location.
- **Pin the source exactly.** Each table entry holds:
  - the script path after the version segment;
  - the 0-based line Playwright reports;
  - the version `9.4.0` in the mount segment `9.4.0-<hash>`. The hash is matched as `[^/]+` and never recorded.

  A Document Server upgrade or another script that registers `unload` is a lane failure, to be re-measured and decided again.

- **Same origin only.** The location URL's origin must equal the platform's public origin, which is `workbenchSession`'s `platform.origin`.
- **No count limit, but recorded.** `unloadViolations` lists one source per allowed report, in arrival order. An allowed report counts whatever `message.type()` it has; Chromium reports it as `error`.
- **`pdfeditor` is not allowed.** It has the same assignment upstream (`pdfeditor/main/app/controller/Main.js:1705`, 1-based), but no lane opens a PDF in the editor, so its line was not measured.

## Seams under test

- **`documentServerUnload`** is exported and pure. It is tested directly.
- **`workbenchSession`'s console handler** is tested through the existing stand-in browser in `stack-browser-fixture.integration.test.ts`. The stand-in's console message gains `location()`. The case emits these, in order:
  - an allowed report;
  - the same text from an unknown script;
  - the same text from a known script at another line;
  - one ordinary error.

  It asserts `unloadViolations` holds the first report's source only, and `consoleErrors` the other three texts in order.

- **`openHinted`'s collector** is tested through the hints fixture's existing stand-in page, if its console handler is reachable there: an allowed report among the §48 refusals still satisfies the refusal wait, and an unknown-source one does not. If `openHinted` has no stand-in seam, the collector reuses the exported classifier, the case is covered by `pnpm test:stack`, and the PR says so.

## Required evidence

Each mutant is run red, then reverted:

| mutant                                                                  | red                                  |
| ----------------------------------------------------------------------- | ------------------------------------ |
| (a) the classifier ignores the line                                     | the other-line case                  |
| (b) it ignores the path or the version                                  | the unknown-script and version cases |
| (c) it ignores the origin                                               | the cross-origin case                |
| (d) it accepts a text prefix                                            | the altered-text case                |
| (e) `workbenchSession` keeps allowed reports in `consoleErrors` as well | the routing case                     |
| (f) `openHinted` does not filter                                        | its stand-in case, if one exists     |

Then:

- `pnpm check`;
- exact-head local `pnpm test:stack` on main's Playwright 1.63, where `unloadViolations` is empty in every session;
- the exact-head VPS lane.

The 1.65 green run belongs to #670.

## Budget

The stack budget is unchanged: no new session or wait.
