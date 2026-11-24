# Office rewrite notice windows

## Why

This change is slice A of #657, covering A1–A3. A4 (XLSX and PPTX) is a later slice. Line numbers refer to `platform/test/office-rewrite-stack-fixture.ts` on main `4813e2f`.

- **A1 — `cleared` covers one instant.**
  - `cleared` is `heldWithin(noneShown(page), session.timeout)` (`:490`), which returns at the first poll that shows no notice. Nothing looks at the notices after that.
  - The `delay(OBSERVE_MS)` after the session (`:509`) runs once the page has already closed.
  - A late status 2 that sets 「保存未写回文件」 again after the `saved` event cleared it, or any notice appearing after the save, still passes.
- **A2 — the "until" in "shows … until the save landed" is unproven.**
  - `NOTICE_LATCH` is installed once (`:476`). `latched` (`:485`) and the post-save read (`:489`) read the same cumulative `NOTICES_SEEN`.
  - So `REFUSED.saved: true` follows from `window: true` and adds nothing. A notice that flashes in the window and is gone before the employee saves still passes.
- **A3 — fixed 15 s window.**
  - After the Agent turn the lane sleeps `OBSERVE_MS` (`:484`), then reads the latch and `fetched.config` once (`:485-486`).
  - A refresh, or the unsaved case's notice, that arrives after 15 s fails a correct implementation under load. This is a loud failure, never a silent pass.
  - Only the negative conditions (no second refresh, no unexpected notice) need a fixed window. The positive ones (the refresh arrived, the notice latched) can wait until they hold.

## What Changes

- **A3:**
  - After the Agent turn, wait until the positives hold, bounded by `session.timeout`: `fetched.config > open`, plus, for the unsaved case only, `saveFailed` latched.
  - The milliseconds from the seam's start (after the `rewritten` read) to each positive go into the evidence as `arrived` (`null` when the bound passed). They are recorded, not asserted.
  - Then the existing `OBSERVE_MS` window runs for the negatives, and the latch and `fetched.config` are read after it, as today.
  - A positive that never arrives leaves `config.window` at 1 (or `saveFailed.window` false), so `EXPECTED_REWRITE` still fails loudly.
- **A2:** read `NOTICES_SHOWN` immediately before the save's `typeAndSave` (`:487`), as the new per-notice flag `atSave`. The unsaved case expects `saveFailed.atSave: true`; every other flag is false. `saved` keeps its meaning (latched until the save landed).
- **A1:**
  - Once `cleared` is true, re-install `NOTICE_LATCH` (a second install starts the latch afresh), hold `OBSERVE_MS`, and read `NOTICES_SEEN` before `browse` returns.
  - This is the new per-notice flag `quiet`, expected false for all three notices in both cases.
  - `config.saved` is read after that window, so the window also covers "no further refresh after the save".
- **Seam.** The post-turn steps become one exported function, `noticeSpan`: the positive wait, the negative window, `atSave`, the save, `cleared`, then the quiet window. It takes a minimal page (`evaluate` only), the save and the after-clear listing as injected functions, the timeout and the window length. Integration cases drive it with stand-in pages:
  - the notice comes back after the save → `quiet` true → `EXPECTED_REWRITE` mismatch;
  - the notice is gone before the save → `atSave` false → mismatch;
  - the refresh arrives after the window but within the bound → match;
  - the refresh never arrives → `config.window` 1 → mismatch;
  - a second refresh in the window → mismatch.
- **Budget.** Each of the two cases adds one 60 s positive-wait bound (`session.timeout`) and one 15 s quiet window, so `vitest.config.ts` gains +150 s (ledger line, `testTimeout`, Sum line).
- **Docs.**
  - The `docs/LOCAL_STACK.md:196` evidence line gains `atSave`, `quiet` and `arrived`.
  - The `platform/test/README.md:92` evidence contract gains the positive wait, `atSave` and the quiet window.
- **Deviation from the issue's A2 suggestion.** `atSave` is added and `saved` is kept, rather than redefining `saved`. No existing assertion is removed, and the clean case's `saved` still covers the span from the window's end until the save landed.

## Triage

```text
Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: Office rewrite stack lane (clean and unsaved cases); a wrong wait or window could fail a correct implementation or let a reappearing notice pass; the typing case (#652) and the forgotten record (#650) must be untouched
Selected risk packs: Concurrency / shared state / ordering (positive wait before the negative window; latch re-install after cleared); Error handling / rollback / partial outputs (a positive that never arrives fails loudly, never hangs past session.timeout)
Evidence floor: A1/A2/A3 stand-in cases red under mutants (a)–(d) per design § Required evidence, green after; exact-head pnpm test:stack green with the new fields; pnpm check; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `stack-verification`: the Office rewrite lane's notice assertions distinguish a notice that persists until the save, one that comes back after it, and a late refresh.

## Impact

- `platform/test/office-rewrite-stack-fixture.ts` and its integration test
- `vitest.config.ts`: stack ledger, `testTimeout` and Sum line
- `docs/LOCAL_STACK.md:196`
- `platform/test/README.md:92`

Unchanged: `platform-stack.stack.test.ts`, the typing case and `EXPECTED_TYPING`, the forgotten record, and product code.

## Risk packs

- **Concurrency / shared state / ordering — selected.** The positive wait runs before the negative window, and the latch is re-installed only after `cleared`. Tasks 1.1–1.3.
- **Error handling / rollback / partial outputs — selected.** A missing positive is bounded by `session.timeout` and fails the facts check. Task 1.1.
- **Not selected:** secrets (only booleans, counts and milliseconds are added), product code, release.

## Acceptance-criteria mapping (#657, slice A1–A3)

- **A1, A2** (stand-in pages for "the notice reappears after the save" and "the notice is gone before the save" fail; the real stack passes) → 1.2, 1.3, 1.4, 2.2.
- **A3** (positive waits bounded by `session.timeout`, the negative window kept, latency in the evidence, the budget synced) → 1.1, 1.4, 1.5.
- **Shared AC** (red→green per new assertion; nothing lengthened, skipped or removed; exact-head `pnpm test:stack`) → 1.4, 2.1–2.3.
- **A4** → a later slice. The PR says `Refs #657`.
