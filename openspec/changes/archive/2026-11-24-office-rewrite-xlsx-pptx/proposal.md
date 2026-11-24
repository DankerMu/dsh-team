# Office rewrite lane: XLSX and PPTX

## Why

This change is slice A4 of #657, its last open part. A1–A3 landed in #703, B and C1–C3 earlier. Line numbers refer to main `ab13f83`.

- **The rewrite lane covers DOCX only.**
  - `CASES` holds two `.docx` cases (`platform/test/office-rewrite-stack-fixture.ts:53-56`).
  - `typeAndSave(page, 'docx', …)` is hard-coded (`:560`, `:578`).
  - The rewriter `REWRITER` uses python-docx (`:140-146`).
- **The editor fixture already handles all three formats.**
  - `EXTS` and `EDITING` in `office-editor-stack-fixture.ts:30`, `:47-51`.
  - It copies XLSX and PPTX from the Document Server's blank templates (`:319-321`).
  - Spec 18.7 does not limit the Agent rewrite to DOCX.
- **Constraint: the user image has only `python3-docx`** (`images/dsh-user/Dockerfile:7`). The issue forbids adding openpyxl or python-pptx: `images/dsh-user/` is a critical path. So XLSX and PPTX are rewritten with Python's standard `zipfile` alone, symmetric with `READER` (`office-editor-stack-fixture.ts:61-75`).

## What Changes

- **Two new clean cases**, after the two DOCX cases and before the typing case:
  - `xlsx`: `干净改写.xlsx`;
  - `pptx`: `干净改写.pptx`.
  - Each starts from the Document Server's blank template, as the editor lane does. Each runs the same `rewriteCase` steps as the DOCX clean case: open, Agent turn, notice span, type and save, close, forgotten record.
- **The XLSX and PPTX rewrite: a stdlib part rewriter.**
  - It replaces exactly one occurrence of an anchor string in one XML part with a replacement that holds the nonce.
  - It writes the archive back in place (same path, same inode, no temporary file in `/data/work`), as python-docx's `save` does, and prints the nonce. The provider counts a rewrite hit when the tool result carries the nonce.
  - The anchor is missing, or occurs more than once → nonzero exit, and the file is left byte for byte unchanged.
  - XLSX: `xl/worksheets/sheet1.xml`, `<sheetData/>` → one row with an inline-string cell A1 holding the nonce.
  - PPTX: `ppt/slides/slide1.xml`, a run holding the nonce in slide 1's subtitle placeholder. The employee types into the title placeholder (`EDITING.pptx`), so the two nonces sit in different shapes.
- **DOCX is unchanged.** The two DOCX cases and the typing case keep python-docx and their behaviour.
- **Expected facts.** Both new cases are predicted to equal the DOCX clean case's `CLEAN`: no notice, one refetch, `agent-only` → `both` → `both`, no entry change, no forgotten copy. A measuring stack run on the implementation commit checks the prediction before the head is frozen. A mismatch goes to the user as a finding; it is never absorbed into the expected values.
- **No unsaved XLSX or PPTX case.** The issue asks for at least a clean case per format, and an unsaved one only "有余量时". Each case costs about 985 s of stack budget (design § Budget), so two more would add about 1970 s on top of this change's 1970 s. The clean cases cover the Document Server reopening a rewritten XLSX or PPTX, typing into it, saving it, and reading both nonces back. They do not cover whether the XLSX or PPTX editor's refreshed-away session sends a status 2, or leaves a forgotten copy. That is Document Server editor behaviour, so it goes into the PR as an out-of-scope finding.
- **Budget.** `vitest.config.ts` gains a ledger line for the two cases, and `testTimeout` and the Sum line follow.
- **Docs.** `docs/LOCAL_STACK.md:196` and the `platform/test/README.md:92` evidence contract gain the two cases.

## Triage

```text
Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: Office rewrite stack lane (two new cases; the DOCX cases, the typing case and the provider wiring must keep their behaviour); a wrong in-place write would leave a copy in /data/work or change the inode, and a silent anchor miss would make the Agent turn a no-op that still counts as a hit
Selected risk packs: Error handling / rollback / partial outputs (anchor missing or repeated fails loudly and leaves the file unchanged); Contract / compatibility (the provider's per-case rewrite arrays grow from two to four; the evidence object gains two keys)
Evidence floor: part-rewriter integration cases red under mutants per design § Required evidence, green after; freshFile stand-in cases per format; the scenario stand-in with four-entry provider arrays; measuring stack run, then exact-head pnpm test:stack green; pnpm check; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `stack-verification`: the Office rewrite lane covers XLSX and PPTX as well as DOCX.

## Impact

- `platform/test/office-rewrite-stack-fixture.ts` and its integration test. The integration test is at about 795 of the 800 lines that `max-lines` counts (blank and comment lines skipped). So the format layer and its cases move to a new module with its own integration test (design § Must add/change).
- `platform/test/office-editor-stack-fixture.ts`: the template read becomes one exported helper, used by both lanes.
- `vitest.config.ts`: stack ledger, `testTimeout` and Sum line.
- `docs/LOCAL_STACK.md:196`, `platform/test/README.md:92`.

Unchanged: product code, `images/dsh-user/`, the provider (`deployment-model-wire.ts`, which already sizes its arrays from the scripts it is given), the typing case, the forgotten record, and the notice span.

## Risk packs

- **Error handling / rollback / partial outputs — selected.** The part rewriter checks the anchor count before writing anything. Tasks 1.1, 1.4.
- **Contract / compatibility — selected.** The provider's `rewriteCalls`/`rewriteHits` arrays and the configured-scripts check grow to four entries. `officeRewriteLine` prints the two new keys. Tasks 1.2, 1.3.
- **Not selected:** secrets (no new secret-bearing field; nonces stay out of the evidence), concurrency (the cases run one after another, as today), product code, release.

## Acceptance-criteria mapping (#657, slice A4)

- **A4** (XLSX and PPTX each with at least one rewrite case, the assertion shape the same as DOCX, the rewrite stdlib only, `images/dsh-user/` untouched) → 1.1–1.3, 2.2.
- **Shared AC** (red→green per new assertion; nothing lengthened, skipped or removed; exact-head `pnpm test:stack`) → 1.4, 2.1–2.3.
- #657 is closed once this PR merges: A1–A4, B1, B2 and C1–C3 are then all done, C2 as an accepted residual.
