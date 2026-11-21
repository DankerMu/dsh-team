# Design

## Context

The plugin keeps `dirtyRef` true while the editor holds edits that have not reached the Document Server (DS).

- **A `change` push while dirty** only sets the stale banner (`OnlyOfficeView.tsx:266-272`).
- **`onDocumentStateChange(false)`** clears every pending notice and does not refresh (`:218-222`).
- **Refresh paths.** There are three:
  - the banner's reload button (`:319-336`);
  - the clean-editor `change` branch;
  - `onRequestRefreshFile` (`:223-227`).
- **The save guard** refuses K1 once the disk differs from what K1 was issued for (`registry.ts:230-235`).
  - Both status 2 and status 6 go through it (`index.ts:405,428`).
  - Each refusal answers `{"error":1}`, pushes `save-error` on the page's watch stream (`index.ts:442`, `watch.ts:163-167`), and logs `onlyoffice save (key …)` (`index.ts:437-438`).
- **Notification latency.** A rewrite reaches the client no sooner than the sum of three delays:
  - `docker exec` startup;
  - python-docx's save;
  - the watch hub's 500 ms debounce (`watch.ts:64-65,90,195-200`).

  No measurement exists of how long fast co-editing takes to push typed edits to DS.

## Decisions

- **Landing in the window is probabilistic, so it is forced and checked.**
  - All observers and the pre-rewrite `listing` are installed before the first keystroke.
  - The rewrite exec starts while the employee keeps typing filler, and the typing continues until the stale banner latches, bounded by one session timeout. The editor is expected, not known, to stay dirty while keys keep arriving; the precondition below is what checks it.
  - "Stale banner latched within the window" is the case's first explicit assertion. If it is missed, the case fails loudly with the (a) timestamps; it is never asserted as another set of facts.
  - The next mechanism after a miss is the owner's or a plan's decision, for example holding the DS co-editing uplink with Playwright `routeWebSocket` until the banner latches. Delays are never tuned.
- **Observables.** Only flags, counts, timestamps and states are kept.
  - Dirty timeline: a top-window `message` listener for the DS iframe's events. It records only `onDocumentStateChange` / `onRequestRefreshFile` and the boolean payload. Step 1 verifies the message shape; if the shape differs, the case reports it instead of guessing.
  - Watch events: before `openHinted`, a `page.evaluate` replaces `window.EventSource`. The plugin resolves the global at construction time (`OnlyOfficeView.tsx:231-245`), so the wrapper catches its stream. It records each event's `kind` and a timestamp.
  - Positive controls: exactly one wrapped instance has received at least one event, and the `message` listener has seen at least one `onDocumentStateChange(true)` after the first keystroke. If either control fails, the signal is reported as unavailable, never as a zero count.
  - Notices: per-notice `NOTICES_SHOWN` at four points (before typing, at the window's end, after the save, after the close), plus the stale banner's first-latched and first-cleared timestamps.
  - Refreshes: `config` fetch counts.
  - Host: a host `docker logs` read of the employee's instance that keeps only the count and timestamps of `onlyoffice save (key` lines, using the `grep -c` precedent in `office-hints-stack-fixture.ts:229-233`. The output is reduced in Node, and no line text reaches evidence or assertion messages. The host `run` and the instance name come from `office`, so `platform-stack.stack.test.ts:549` changes in place from `{ ...lane, reply, rewrites }` to `{ ...office, reply, rewrites }`, a net change of 0 lines.
- **Secrets.** The save-error banner renders the guard's message, which contains K1, a path and sizes. Masking is a session-level `workbenchSession` option that applies to every screenshot of the session, including its failure screenshot. The locator uses the `saveFailed` locale prefix, so no banner text enters the evidence. The option gets a sibling test. No assertion message or evidence field carries banner text, watch payloads or log lines.
- **Outcomes after step 1.** Two step-1 runs must agree on the window precondition and the final state.
  - If the final file after the employee's last same-editor save is `both` or `employee-only` with no copy, step 2 tightens to the facts and corrects the guide.
  - Otherwise the evidence goes to the owner. The change stays open, the record-only case is not merged as a terminal state, and the MUST is neither weakened nor asserted as violated.
- **Budget** (itemized in the `vitest.config.ts` comment). Each of these is bounded by one 60 s session timeout:
  - the DS healthcheck wait;
  - the editor load;
  - the typing-until-latch bound;
  - the second typing;
  - the save poll;
  - the notice-clear wait.

  Then:
  - two 15 s observation windows: a 15 s hold after the stale latch, which is the window's end, and 15 s after the close for status-2 retries;
  - docker execs at 30 s each: the write, four reads, the rewrite, three listings and the host log reads;
  - the provider reads before and after.

## Sibling surfaces

- **`clean` and `unsaved`.** These two cases, `CASES`, `ownedRewrites`, the `Rewrite scripts configured` assertion and `EXPECTED_REWRITE` are unchanged.
- **Work-file cleanup.** The new file name joins `withWorkFiles`' cleanup list.
- **Out of scope.** XLSX and PPTX stay out of scope (#652).
