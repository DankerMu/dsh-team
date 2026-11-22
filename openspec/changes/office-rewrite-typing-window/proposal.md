# Office rewrite while typing is in flight

## Why

PR #642 (#442 §60) verified two cases of an Agent rewriting a DOCX that is open in ONLYOFFICE: the editor was clean, or the typing had already reached the Document Server. In both runs the editor refreshed to the new key, and 「文件已被外部修改」 never showed (`office-rewrite-stack-fixture.ts:31-77`).

The window where the employee's typing has not yet reached the Document Server has never been exercised. In that window, `dsh-sidebar-onlyoffice@0.2.0` (upstream code, unpatched in the image) does three things:

- It shows the stale banner and does not refresh (`src/client/OnlyOfficeView.tsx:266-272`).
- It clears that banner once the edit reaches the server, again without refreshing (`:218-222`). The banner was the only reload control.
- The plugin's own staleness guard refuses every later save of the old key K1 (`src/registry.ts:230-235`).

So the code suggests the employee's last save never reaches the file. That would contradict `office-editing` 「编辑器打开时 Agent 改文件的表现」 (后写覆盖). `docs/EMPLOYEE_GUIDE.md` §「AI 改写正在编辑的文件」 says this case is unverified.

Owner direction (#652 triage, 2026-11-21): do the ready part (the stack case and the measurement) first; the owner then decides the mitigation. Measured result (tasks 2.1): the MUST is violated. Owner decision (2026-11-21): a pinned build-time patch of `lib/client.js` that refreshes once when the editor turns clean after a change arrived while it was dirty, plus an upstream issue. This is a critical path (`images/dsh-user/`) and needs a human line-by-line review.

**Expected path.** From the code, unless a refused save triggers `onRequestRefreshFile` (#652 (b)), K1's saves are refused and the MUST cannot hold in this change. The owner stop at task 2.1 is therefore the expected outcome, not an exception.

## What Changes

- **Stack case `typing`**, a separate function beside `rewriteCase` in `office-rewrite-stack-fixture.ts`. It is not an entry in `CASES` and makes no Agent turn: the provider counts are asserted unchanged across it. The case runs in this order:
  1. Install every observer before typing:
     - the notice latch;
     - a top-window `message` listener that records only the event name (`onDocumentStateChange`, `onRequestRefreshFile`) and its boolean payload, each with a timestamp;
     - an `EventSource` wrapper, installed with `page.evaluate` before the editor opens, that records only each watch event's `kind` and a timestamp, with positive controls (one instance and at least one event; at least one dirty `true`);
     - the pre-rewrite `listing`.
  2. Type a nonce unsaved, then keep typing filler concurrently with the rewrite `lane.exec(rewriteCommand(name, nonce))`. No screenshot or exec runs between them.
  3. Stop typing when the stale banner latches, or at a bound of one session timeout. This is a conditional poll, not a guessed sleep.
  4. The employee then types a second nonce in the same editor and presses Ctrl+S.
  5. Read `rewriteState` and `typed` after the rewrite, after the save, and after the close.
- **Measurements** (#652 (a)(b)(c)). Each is a recorded number or event count.
  - (a) Window width, from the dirty timeline: last keystroke, exec start and return, stale latch, dirty true→false.
  - (b) `onRequestRefreshFile` count and `config` refetches after the refused save.
  - (c) Document Server retries: the page's `save-error` watch events while the editor is open, and the host's per-instance plugin log line count for refused saves (count and timestamps only) after the close.
- **No secrets in evidence.** The save-error banner text carries K1, a path and sizes (`OnlyOfficeView.tsx:358-360`, `registry.ts:231-234`).
  - Every screenshot of the session masks that span, including the failure screenshot, through a session-level `workbenchSession` option.
  - Evidence and logs keep only flags, counts, timestamps and states, never banner, message or log text.
- **Two steps.**
  1. Step 1 commits the case as record-only: the window precondition, the lane's no-copy invariants, the allowed console errors, the screenshot list and the recorded facts.
  2. After two orchestrator `pnpm test:stack` runs agree, step 2 depends on the outcome:
     - If the employee's last save lands, tighten to the observed facts and correct the guide.
     - Otherwise stop. The change stays open with the record-only case unmerged, and the owner decides the mitigation.
- **Docs and budget** (step 2 only):
  - Rewrite `docs/EMPLOYEE_GUIDE.md` §「AI 改写正在编辑的文件」.
  - Add a `stackEvidence.officeRewrite` row to `docs/LOCAL_STACK.md`; none exists yet.
  - Update the #442 lane entry in `platform/test/README.md:92`.
  - The `vitest.config.ts` stack `testTimeout` grows by the itemized bound in step 1.

## Triage

```text
Issue type: test (+docs)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: stack lane only (local, ~11 min); a mis-tightened assertion fails the lane; the guide is employee-visible; screenshots/logs could leak K1 if unmasked; a wrong measurement misleads the owner's mitigation decision
Selected risk packs: Concurrency / shared state / ordering; Error handling / rollback / partial outputs; File IO / path safety / overwrite; Auth / permissions / secrets; Documentation / migration notes
Evidence floor: two agreeing step-1 stack runs recording (a)(b)(c) with masked screenshots; owner decision if the MUST fails; otherwise step-2 exact-head pnpm test:stack green with tightened assertions; inventory/volume fence; pnpm check; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `office-editing`: the Agent-rewrite requirement covers the in-flight typing window.

## Impact

- `platform/test/office-rewrite-stack-fixture.ts` (382 lines), or a new sibling fixture if the size or complexity limits require one, wired through the existing `officeRewriteScenario` and `officeRewriteLine`. `platform/test/platform-stack.stack.test.ts` changes only `:549` in place (`...lane` becomes `...office`, so the host `run` and the instance name are available), a net change of 0 lines: about 794 of its 800 effective lines are used.
- `platform/test/stack-browser-fixture.ts`: a session-level screenshot mask option, with its sibling test.
- Host-side log-count wiring for (c).
- `vitest.config.ts`, `docs/EMPLOYEE_GUIDE.md`, `docs/LOCAL_STACK.md` and `platform/test/README.md`.
- Nothing under `images/`, `plugins/` or `platform/src/`.
