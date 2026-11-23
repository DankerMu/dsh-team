## 1. Implementation

- [ ] 1.1 A3:
  - the positive wait (`fetched.config > open`, plus `saveFailed` latched in the unsaved case), bounded by `session.timeout`;
  - `arrived` in the evidence;
  - then the existing `OBSERVE_MS` window and the `latched` / `window` reads.
- [ ] 1.2 A2: `atSave` from `NOTICES_SHOWN` right before the save. Add it to `noticeFlags`, `UNSEEN` and `REFUSED`.
- [ ] 1.3 A1:
  - after `cleared`, re-install `NOTICE_LATCH`, hold `OBSERVE_MS`, then read `NOTICES_SEEN` as `quiet`;
  - read `config.saved` after that window.
- [ ] 1.4 Seam and integration cases:
  - extract `noticeSpan` in the order given in design § Must add/change;
  - export `NOTICE_LATCH`, `NOTICES_SEEN` and `NOTICES_SHOWN`;
  - add the positive, A1, A2 and A3 stand-in cases and the `it.each` rows (design § Required evidence);
  - show mutants (a)–(d) red, then green, and record each run for the PR.
- [ ] 1.5 Budget and docs:
  - `vitest.config.ts`: a ledger line for #657 A (+150 s: two 60 s positive-wait bounds and two 15 s quiet windows), with `testTimeout` and the Sum line updated;
  - `vitest.config.ts:104`: the margin becomes 8880 s;
  - `docs/LOCAL_STACK.md:196`: add `atSave`, `quiet` and `arrived`, and reword `config`'s third count;
  - `platform/test/README.md:92`: the positive wait, `atSave` and the quiet window;
  - the stale comments listed in design § Sibling surfaces.
- [ ] 1.6 PR: the diff exceeds 400 lines (the OpenSpec files count), so apply `diff-limit-exempt` before pushing the frozen head, with the justification in the body. Report the typing case's same-shape gap as an out-of-scope finding.

## 2. Verification

- [ ] 2.1 `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [ ] 2.2 Exact-head local `pnpm test:stack`: green with the new fields, and the inventory/volume fence passes.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy` with confirmed cleanup (the repository gate for non-docs PRs).
