## Risk packs

- **Concurrency / shared state / ordering — selected.** Typing, the inotify `change` and the Document Server save race each other. Observers are installed before typing, the rewrite runs while typing continues, and a stale-latch precondition fails loudly when the window is missed. Tasks 1.1, 1.2.
- **Error handling / rollback / partial outputs — selected.** Covers refused saves, Document Server retries (status 6 while open, status 2 after close), and where the in-window typing ends up. Tasks 1.1, 1.2, 2.1.
- **File IO / path safety / overwrite — selected.** No copy, `.tmp-*` or `.abandoned` in `/data/work`; 后写覆盖. Tasks 1.1, 2.1.
- **Auth / permissions / secrets — selected.** The save-error banner carries K1, a path and sizes. Screenshots mask it; evidence keeps no banner, watch-payload or log text. Task 1.2.
- **Documentation / migration notes — selected.** The guide is rewritten only after a measured, MUST-satisfying outcome. Task 2.2.
- **Not selected:** product code and release. No image, plugin or `platform/src/` change in this change.

## Acceptance-criteria mapping (#652)

- **AC1** (new stack case; banner, `config`, Ctrl+S outcome and `rewriteState` after save and close; tightened) → 1.1, then 2.1 when the MUST holds.
- **AC2** ((a)(b)(c) recorded; no key, token or cookie) → 1.2, 2.1. (c) is marked partial only if both the page signal and the host signal are proven unavailable.
- **AC3** (final file `both`/`employee-only` with no copy, or violation evidence and an owner decision; never docs only) → 2.1.
- **AC4** (guide matches; `:61` no longer "unverified") → 2.2, only when the MUST holds.
- **AC5** (stack `testTimeout` by convention; nothing else lengthened, skipped or removed) → 1.3.
- **AC6** (`images/dsh-user/` patch) → not in this change; the owner decides at 2.1.

## Must preserve

- `clean` and `unsaved`, `CASES`, `ownedRewrites`, the `Rewrite scripts configured` assertion, `EXPECTED_REWRITE` facts and screenshots.
- `platform/test/platform-stack.stack.test.ts` changes only `:549`, in place from `...lane` to `...office`, a net change of 0 lines. Wiring goes through `officeRewriteScenario` and `officeRewriteLine`.
- Every other lane's assertions and deadlines.
- No DSH or plugin source change; nothing under `images/`.
- No key, token, cookie, banner or log filesystem path, banner text, watch payload, log line or conversation content in evidence, assertion messages or screenshots. The existing file names and `status path` response lines stay as they are.
- The 800-line, function-length and complexity limits.

## 1. Implementation (step 1: record only)

- [ ] 1.1 Add the `typing` case as its own function, outside `CASES`, with no Agent turn. Provider counts are asserted unchanged across it, and its file name joins `withWorkFiles`. Sequence:
  1. Write a fresh DOCX and wait for DS ready.
  2. Install the `EventSource` wrapper (task 1.2), then open the editor.
  3. Install the remaining observers (task 1.2) and take the pre-rewrite `listing`.
  4. Type a nonce unsaved.
  5. Start `lane.exec(rewriteCommand(name, agentNonce))` while filler typing continues. The filler is letters only: no trailing space or punctuation, which would trigger autocorrect, and nothing that matches `NONCE_PATTERN`. Stop typing when the stale banner latches, or after one session timeout.
  6. Assert first that the stale banner latched within the window. If it did not, fail loudly with the (a) timestamps.
  7. Hold 15 s after the latch; that is the window's end. Then read the per-notice state.
  8. Type a second nonce in the same editor and press Ctrl+S.
  9. Poll the save, then read the notices and record whether they clear.
  10. Close, then hold one 15 s observation window.

  Read `rewriteState` and `typed` after the rewrite, after the save and after the close. Record work-entry diffs and console, page and failed-request counts. Expect record-only: the window precondition, no copy/`.tmp-*`/`.abandoned`, allowed console errors, the screenshot list. Put the facts in the case's evidence through `officeRewriteLine`.

- [ ] 1.2 Observers and measurements:
  - **Dirty timeline:** a top-window `message` listener recording only the event name (`onDocumentStateChange`/`onRequestRefreshFile`), the boolean and a timestamp. Verify the DS message shape; report it if it differs.
  - **Watch events:** before `openHinted`, a `page.evaluate` wrapper around `window.EventSource` records only `kind` and a timestamp.
  - **Positive controls:** one wrapped instance has received at least one event, and at least one `onDocumentStateChange(true)` is seen after the first keystroke. If a control fails, the signal is reported as unavailable, never as 0.
  - **Notices:** per-notice `NOTICES_SHOWN` before typing, at the window's end, after the save and after the close, plus the stale banner's first-latched and first-cleared timestamps.
  - **Refreshes:** `config` counts.
  - **Host log:** a host `docker logs` count, with timestamps, of the instance's `onlyoffice save (key` lines, before and after the close. The output is reduced in Node, and no line text is kept or reaches an assertion message. `:549` passes `...office` (see Must preserve).
  - **Screenshot masking:** a session-level `workbenchSession` option masks the save-error span in every screenshot, including the failure screenshot. It is located by the `saveFailed` locale prefix and has a sibling test in `stack-browser-fixture`.
  - **(a)–(c):**
    - (a): last keystroke, exec start and return, stale latch, dirty true→false;
    - (b): `onRequestRefreshFile` count and `config` refetches after the refused save;
    - (c): `save-error` watch events while open, and host log-line count after close.
  - Sibling unit tests cover any new pure helper.
- [ ] 1.3 Raise the stack `testTimeout` in `vitest.config.ts` by the bound itemized in `design.md` § Budget, with a comment naming each term.

## 2. Measurement, decision, tightening, docs

- [ ] 2.1 The orchestrator runs local `pnpm test:stack` twice on the step-1 head and records (a), (b) and (c), the facts and the masked screenshots in the PR.
  - **Window precondition not met:** stop and report it with the timestamps.
  - **Runs disagree:** stop and report both runs.
  - **Employee's last same-editor save lands** (`both` or `employee-only`, no copy): the implementer tightens the `typing` expectation to the observed facts.
  - **Save does not land (expected):** stop.
    - Post the evidence to the owner.
    - The change stays open, and the record-only case is not merged as a terminal state.
    - 2.2–2.4 do not run until the owner decides (an upstream issue, a pinned build-time patch on the critical path, or another direction) and a follow-up makes the MUST hold.
    - Record the decision here.
- [ ] 2.2 Only when the MUST holds:
  - Rewrite `docs/EMPLOYEE_GUIDE.md` §「AI 改写正在编辑的文件」 (`:61` no longer "unverified", the `:67` bullet, the advice) to the measured behaviour, including where in-window typing goes.
  - Add a `stackEvidence.officeRewrite` row to `docs/LOCAL_STACK.md`.
  - Update `platform/test/README.md:92`.
- [ ] 2.3 Exact-head `pnpm test:stack` passes with the tightened case. Run the inventory/volume fence and check that no new console errors appear beyond the allowed set. Run `pnpm check`.
- [ ] 2.4 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, with confirmed cleanup.
