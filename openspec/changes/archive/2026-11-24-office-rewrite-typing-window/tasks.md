## Risk packs

- **Concurrency / shared state / ordering — selected.** Typing, the inotify `change` and the Document Server save race each other. Observers are installed before typing, the rewrite runs while typing continues, and a stale-latch precondition fails loudly when the window is missed. Tasks 1.1, 1.2.
- **Error handling / rollback / partial outputs — selected.** Covers refused saves, Document Server retries (status 6 while open, status 2 after close), and where the in-window typing ends up. Tasks 1.1, 1.2, 2.1.
- **File IO / path safety / overwrite — selected.** No copy, `.tmp-*` or `.abandoned` in `/data/work`; 后写覆盖. Tasks 1.1, 2.1.
- **Auth / permissions / secrets — selected.** The save-error banner carries K1, a path and sizes. Screenshots mask it; evidence keeps no banner, watch-payload or log text. Task 1.2.
- **Documentation / migration notes — selected.** The guide is rewritten only after a measured, MUST-satisfying outcome. Task 2.2.
- **Release / packaging / dependency compatibility — selected after 2.1:** the build-time patch pins `dsh-sidebar-onlyoffice@0.2.0` `lib/client.js` by sha256, and a mismatch fails the image build. Task 2.1a.
- **Not selected:** `platform/src/`.

## Acceptance-criteria mapping (#652)

- **AC1** (new stack case; banner, `config`, Ctrl+S outcome and `rewriteState` after save and close; tightened) → 1.1, then 2.1 when the MUST holds.
- **AC2** ((a)(b)(c) recorded; no key, token or cookie) → 1.2, 2.1. (c) is marked partial only if both the page signal and the host signal are proven unavailable.
- **AC3** (final file `both`/`employee-only` with no copy, or violation evidence and an owner decision; never docs only) → 2.1.
- **AC4** (guide matches; `:61` no longer "unverified") → 2.2, only when the MUST holds.
- **AC5** (stack `testTimeout` by convention; nothing else lengthened, skipped or removed) → 1.3.
- **AC6** (`images/dsh-user/` patch with sha256 pin, build fails on mismatch, critical-path review, exact-head `pnpm test:docker` and `pnpm test:stack`) → 2.1a, 2.1b, 2.3, 2.4. The owner decided on 2026-11-21.

## Must preserve

- `clean` and `unsaved`, `CASES`, `ownedRewrites`, the `Rewrite scripts configured` assertion, `EXPECTED_REWRITE` facts and screenshots.
- `platform/test/platform-stack.stack.test.ts` changes only `:549`, in place from `...lane` to `...office`, a net change of 0 lines. Wiring goes through `officeRewriteScenario` and `officeRewriteLine`.
- Every other lane's assertions and deadlines.
- No DSH source change. The plugin is changed only by the pinned build-time patch (2.1a). `images/dsh-user/` changes only in `patch-package.mjs`, its test and one `Dockerfile` comment. `platform/test/user-image.docker.test.ts` updates the delivered `lib/client.js` hash to the patched output (`ada60b40…`).
- No key, token, cookie, banner or log filesystem path, banner text, watch payload, log line or conversation content in evidence, assertion messages or screenshots. The existing file names and `status path` response lines stay as they are.
- The 800-line, function-length and complexity limits.

## 1. Implementation (step 1: record only)

- [x] 1.1 Add the `typing` case as its own function, outside `CASES`, with no Agent turn. Provider counts are asserted unchanged across it, and its file name joins `withWorkFiles`. Sequence:
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

- [x] 1.2 Observers and measurements:
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
- [x] 1.3 Raise the stack `testTimeout` in `vitest.config.ts` by the bound itemized in `design.md` § Budget, with a comment naming each term.

## 2. Measurement, decision, tightening, docs

- [x] 2.1 The orchestrator ran local `pnpm test:stack` twice on the step-1 head `f95bb48`. Both passed and agreed (inventory unchanged apart from the authorised RAGFlow restart, VOL-SAME), in 748.78 s and 808.64 s.
  - **Window precondition met.** The rewrite exec ran from 606 to 703 ms (run b: 423 to 520 ms). The stale banner latched at 1509 ms (1067 ms). Dirty went true at 709 ms (466 ms) and false at 2499 ms (2272 ms). The banner cleared at 2500 ms (2272 ms), at the dirty→false transition, without a refresh. This confirms `OnlyOfficeView.tsx:218-222`.
  - **(a) Window width:** about 1.8 s, from the first dirty=true to dirty=false.
  - **(b) Refresh:** `onRequestRefreshFile` fired 0 times, including after the refused save. The `config` count stayed at 1 from open through end, so nothing refreshed.
  - **(c) Retries:** exactly one `save-error` watch event, after Ctrl+S (17142 ms; 16701 ms). No further retry arrived while the editor stayed open. The host-log signal was unavailable ("no earlier line"): the plugin's cordis logs stay in memory and never reach `docker logs`.
  - **Outcome:**
    - The employee's Ctrl+S was refused: 「保存未写回文件」 was shown at save and at end, together with ONLYOFFICE's own 「保存文件时出错」 dialog.
    - `rewriteState` was `agent-only` after the rewrite, after the save and after the close, with `typed: false` in all three reads. Neither the in-window typing nor the later saved nonce reached the file.
    - No copy appeared in `/data/work`. The masked screenshots were checked visually.
    - **The MUST (后写覆盖) is violated.**
  - **Owner decision, 2026-11-21:** a build-time patch plus an upstream issue.
    - Pin `dsh-sidebar-onlyoffice@0.2.0` `lib/client.js` in `images/dsh-user/patch-package.mjs` with input and output sha256. A version mismatch fails the build.
    - The patch behaviour: when the editor turns clean (dirty→false) while a `change` arrived during the dirty state, refresh once (`refreshNow`) instead of only clearing the banner.
    - File an issue upstream at `chendefine/dsh-sidebar-onlyoffice`.
    - This is a critical path (`images/dsh-user/`): the PR asks for a human line-by-line review.
- [x] 2.1a Patch (implementer):
  - Per-target replacements in `PINS.onlyoffice`. The engine applies one replacement list to every target, so each target gets its own list, with the existing `lib/index.js` list unchanged.
  - The `lib/client.js` target (input sha256 `13df10ce7e4d94ae2951f184c54f69b47d7d7a04f8c50b2f6c201602a7fa0cbc`) gets four replacements, each anchored on text that occurs exactly once:
    - a pending-change flag in the effect scope, declared beside `refreshNow`, which clears it first;
    - the flag is set in the `es.onmessage` dirty branch (`client.js:357-359`);
    - the `onDocumentStateChange` clean branch (`:316-320`) refreshes once when the flag is set, and otherwise clears the banner as released;
    - `refreshNow`'s failed-fetch branch sets the flag again, so the next clean transition retries (review round 1).
  - The `removed` banner and the clean-editor branch are unchanged.
  - Sibling unit tests in the `patch-package` test cover the new target: the anchors, sha mismatch refusal, and per-target replacement isolation.
- Patched measurement (orchestrator). Two local `pnpm test:stack` runs on `6f43c7e` both passed and agreed (VOL-SAME; inventory unchanged apart from the authorised RAGFlow restart), in 702.26 s and 688.08 s.
  - The stale banner latched in the window (at 1433 and 1886 ms). At dirty→false (2582 and 2818 ms) the editor refreshed once: `config` went 1 to 2, and the banner cleared (2594 and 2832 ms).
  - The refreshed-away session's status 2 was refused, so 「保存未写回文件」 appeared in the window. `save-error` arrived at 7956 and 8181 ms.
  - The employee's next Ctrl+S was saved: one `saved` event. It cleared the notice, and no notice was shown after the save or at the end.
  - File state was `agent-only` after the rewrite, then `both` after the save and `both` after the close, with `typed: false` throughout. The in-window typing was discarded, as in `unsaved`.
  - No copy, `onRequestRefreshFile` 0. The MUST holds.
- [x] 2.1b Tighten `EXPECTED` for `typing` to the patched behaviour, shown by two agreeing exact-head stack runs:
  - the stale banner latched in the window;
  - one refresh (`config` 2) at dirty→false;
  - after the save, the file is `both` for the employee's last save, and the in-window typing is gone, as in `unsaved`;
  - no copy;
  - `saveFailed` behaves as the stack runs show for the refused K1 session.

  Keep the record-only facts as evidence.

- [x] 2.1c Orchestrator: filed https://github.com/chendefine/dsh-sidebar-onlyoffice/issues/1 with the measured facts and the suggested fix. It contains no deployment, user, key or path details.
- [x] 2.2 Only when the MUST holds:
  - Rewrite `docs/EMPLOYEE_GUIDE.md` §「AI 改写正在编辑的文件」 (`:61` no longer "unverified", the `:67` bullet, the advice) to the measured behaviour, including where in-window typing goes.
  - Add a `stackEvidence.officeRewrite` row to `docs/LOCAL_STACK.md`.
  - Update `platform/test/README.md:92`.
- [x] 2.3 Exact-head `pnpm test:stack` passes with the tightened case. Run the inventory/volume fence and check that no new console errors appear beyond the allowed set. Run `pnpm check`.
- [x] 2.4 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, with confirmed cleanup.
