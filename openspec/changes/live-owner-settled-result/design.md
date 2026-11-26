# Design

Change surface: `boundCommand` (`platform/test/trusted-docker-uncaptured-fixture.ts:195-212`), reached through `claimUncaptured` (`:236-277`) by `trusted-docker-fixture.ts:470-495`.

Must preserve:

- Receipt path: `child.json` present → bound from it, whatever the owner's state or `result.json`.
- Exited-owner path (#718): no receipt, settled valid result → `command finished`; otherwise `command unidentified (owner gone without receipt)`.
- Live owner, scan finds a command → `command <pid>`, even when `result.json` is settled. The scan wins, because a settled result cannot vouch for a process that is still there.
- Live owner, scan finds none, result missing, unreadable, invalid or unsettled → `no command started`, with the authority handed back and the caller's "retained" failure as today.
- Owner settle on every path, and the stop-then-kill fallback on a failed settle.
- Existing `no command started` assertions: `trusted-docker-uncaptured-fixture.integration.test.ts:315` (owner stuck before spawn, no `result.json`) and `:525` (`zero children`, no `result.json`).
- `max-lines` (800, constraints.yaml) with a margin for `trusted-docker-uncaptured-fixture.integration.test.ts` (657 lines at 46c07e9; the new rows add about 4).
- Every uncertain scan outcome (`scan failed`, owner unlisted, `ambiguous child`, `in-flight child` past its wait, `command … unobservable`) stays `command unidentified (…)` with the authority retained, whatever `result.json` says. Only a clean `none` scan reads `result.json`.

Must add/change:

- Stopped owner and a clean `none` scan (`scannedCommand` returned `undefined`): `settledResult(root, invocation).catch(() => false)` decides `finished` or `none`.
- Comments that the fix makes wrong: the `settledResult` docstring ("a gone owner's own result.json", `:178-181`), the `boundCommand` docstring ("A gone owner without a receipt…", `:190-193`) and its inline comment (`:209`), and `lateFinish`'s "A live owner would be frozen and scanned instead: claimed for the wrong reason" (test `:272`), which becomes "waits for the owner to exit so this case keeps covering the exited path".

Governing invariant: cleanup hands back an authority as `finished` only when no command of the owner is observable and this invocation's validated `result.json` records a settled command, whether or not the owner is still alive.

Sibling surfaces:

- `scannedCommand` (`:159-176`): unchanged; its `in-flight child` retry and unidentified errors keep their meaning.
- `settledResult` (`:182-187`): reused, not copied.
- `trusted-docker-fixture.ts:491-492`: reads `finished`; unchanged.
- The owner (`scripts/trusted-docker-owner.mjs`): unchanged.

Seams under test: the `claims an uncaptured owner` table in `trusted-docker-uncaptured-fixture.integration.test.ts`, with its injected `UncapturedCustody` (live flags, `ps` outputs, event log) and an on-disk `result.json`.

Required evidence (new table rows):

- Live owner, settled valid `result.json`, no receipt, scan `none` → report `command finished`, `finished: true`, authority handed back, events `SIGSTOP`, `ps stat`, `ps scan`, `settle`. Red before: report `no command started` and no `finished`.
- Live owner, `result.json` unsettled, then invalid (wrong invocation id), no receipt, scan `none` → `no command started`, no `finished` (green both before and after).
- Live owner, settled valid `result.json`, no receipt, scan finds a command → `command <pid>`, no `finished` (green both before and after).
- Live owner, settled valid `result.json`, no receipt, rows `[owner, child(7, 7, 'sh')]` → `unbound('ambiguous child 7')`, retained, events as for the existing frozen ambiguous row (green both before and after).
- `pnpm test:integration` passes; `pnpm lint` passes with the test file's `max-lines` margin.

Non-goals: the owner's write order; the exited-owner path; the receipt path.

Review focus:

- `finished` is never returned while a command is observable.
- Validation of `result.json` uses the same invocation id and manifest digest as the exited path.
- Event sequence and the settle-on-every-path guarantee.
