# Design

## Decisions

- **Classify each message once, in one function, at both collectors.** `recordedError(message, origin)` is the only place that reads a console message's type, text and location. `workbenchSession`'s handler and `openHinted`'s collector call it and branch on the result. Every lane matcher (`serviceWorkerRefused`, `editorErrorsAllowed`, the rewrite and forgotten checks) then keeps its exact shape. The alternative was adding the text to each matcher. That means five matchers, each with its own count rule, and none of them sees the location.
- **Pin the source exactly.** Each table entry holds:
  - the script path after the version segment;
  - `ConsoleMessage.location().line`, which is 0-based. The table's 2145, 1785 and 1638 are the issue's 1-based 2146, 1786 and 1639. `lineNumber` is deprecated in Playwright 1.63, and `no-deprecated` is an error;
  - the version `9.4.0` in the mount segment `9.4.0-<hash>`. The hash is matched as `[^/]+` and never recorded.

  The match uses `new URL(url).pathname`, so a query or hash is ignored. An empty `url` is checked before `new URL`, so it can never throw inside a console listener; it yields an `error`. A Document Server upgrade, or another script that registers `unload`, is a lane failure, to be re-measured and decided again.

- **Same origin only.** The location URL's origin must equal the platform's public origin, `workbenchSession`'s `platform.origin`, and the same for `openHinted`'s `base`.
- **Error type only.** Both collectors already take only `error`-type messages; `recordedError` keeps that gate, returning `undefined` for any other type.
- **No count limit, but each source printed.** `unloadViolations` lists one source per allowed report, in arrival order. The evidence lines print the list, not a count.
- **`pdfeditor` is not allowed.** It has the same assignment upstream (`pdfeditor/main/app/controller/Main.js:1705`, 1-based), but no lane opens a PDF in the editor, so its line was not measured.

## Seams under test

- **`recordedError`** is exported. It is tested directly with a stand-in message object, `{ type, text, location: () => ({ url, line, column }) }`.
- **`workbenchSession`'s handler** is tested through the existing stand-in browser in `stack-browser-fixture.integration.test.ts`. Today it emits a console message only on `gotoFailure` (`:143`); it gains an option to emit a list of messages, each with `location()`. The case emits these, in order:
  - an allowed report;
  - the same text from an unknown script;
  - the same text from a known script at another line;
  - one ordinary error.

  It asserts `unloadViolations` holds the first report's source only, and `consoleErrors` the other three texts in order.

- **`openHinted`'s collector** is tested through a new minimal stand-in page in `office-hints-stack-fixture.integration.test.ts`, with `on`, `off`, `evaluate` and `evaluateHandle`, after the `answer(expression)` pattern of `office-rewrite-stack-fixture.integration.test.ts:418-429`. Two cases:
  - an allowed report arriving before the two §48 refusals still satisfies the refusal wait;
  - an unknown-source report in the same place does not, and the wait fails with the collected errors.

## Required evidence

Each mutant is run red, then reverted:

| mutant                                                                  | red                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| (a) the classifier ignores the line                                     | the other-line case                                                 |
| (b) it ignores the path or the version                                  | the unknown-script and version cases                                |
| (c) it ignores the origin                                               | the cross-origin case                                               |
| (d) it accepts `startsWith`                                             | the extended-text case. The truncated-text case covers the reverse. |
| (e) `workbenchSession` keeps allowed reports in `consoleErrors` as well | the routing case                                                    |
| (f) `openHinted`'s collector does not classify                          | the early-report stand-in case                                      |

Then:

- `pnpm check`;
- exact-head local `pnpm test:stack` on main's Playwright 1.63, where `unloadViolations` is empty in every session;
- the exact-head VPS lane.

The 1.65 green run belongs to #670.

## Budget

The stack budget is unchanged: no new session or wait.
