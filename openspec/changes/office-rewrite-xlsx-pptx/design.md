# Design

## Change surface

- **New module `platform/test/office-rewrite-formats.ts`.** The per-format layer is self-contained, and the rewrite fixture's integration test is at about 795 of the 800 lines `max-lines` counts (`eslint.config.mjs:25`: blank and comment lines skipped). So the layer and its cases move out:
  - `REWRITER` (python-docx, moved unchanged);
  - the new stdlib `PART_REWRITER`;
  - the per-format table `PARTS` (part, anchor, replacement built from the nonce);
  - `rewriteArgv(name, nonce)`, which dispatches on the file's extension;
  - `rewriteCommand(name, nonce)`;
  - the exported per-format fresh-file step `freshFile(lane, case)` (below).
  - Its integration test `office-rewrite-formats.integration.test.ts` takes over the existing `REWRITER` and quoting cases (`office-rewrite-stack-fixture.integration.test.ts:97-128`). It also holds every new case: the part rewriter, the per-extension argv and `freshFile`.
- **`office-rewrite-stack-fixture.ts`:**
  - `CASES` gains `ext` and the two new cases;
  - `freshDocx` is replaced by `freshFile` from the new module;
  - `rewriteCase` passes the case's `ext` to `typeAndSave`, and its `index` widens from `0 | 1`;
  - `turnDeltas`/`agentRewrite` take that index;
  - `EXPECTED_REWRITE` gains `xlsx` and `pptx`;
  - `OfficeRewriteEvidence`, `officeRewriteLine` and `officeRewriteScenario` gain the two keys;
  - the configured-scripts check becomes four zeros per array.
- **`office-editor-stack-fixture.ts:319-320`:** the template read becomes one exported function (for example `templateBase64(run, ext)`), called by `editAndSave` and by the rewrite lane. There is no second copy of the template path or the `base64 -w0` exec.
- **`office-rewrite-stack-fixture.integration.test.ts`:**
  - the stand-in lane's `provider` arrays only (four entries each);
  - the per-case `it.each` rows and the print case gain the two cases where they range over cases.
- `vitest.config.ts` (`:49-115`), `docs/LOCAL_STACK.md:196` and `platform/test/README.md:92`.

## Must preserve

- **The DOCX cases and the typing case keep their behaviour:**
  - the same file names, python-docx `REWRITER` text (byte for byte), `PARAGRAPH` and its first-read check, steps, facts and screenshots;
  - `EXPECTED_REWRITE.clean`, `.unsaved` and `EXPECTED_TYPING` unchanged.
- **Order:** `clean`, `unsaved`, then `xlsx`, `pptx`, then `typing`. Provider script index `i` belongs to `CASES[i]`.
- **The notice span (`noticeSpan`), `rewriteFacts`, the forgotten record and `clearingForgottenOnError`** are unchanged. Each new case runs inside `clearingForgottenOnError` like the DOCX cases.
- **The screenshot mask** (`masked: [NOTICES.saveFailed]`) applies to every new session.
- **No nonce, key or notice text** in the evidence.
- **The Agent's command stays single-quoted words, with no single quote in any word.** `singleQuoted` throws on one.
- **Limits:** 800 lines per file (as `max-lines` counts them), complexity 15, 200 lines per function. The fixture, the new module and both integration tests stay under them. The rewrite fixture's integration test must not grow overall: what it gains (provider arrays, rows for the two cases) is paid for by the cases it hands to the new test.
- **`images/dsh-user/`, the provider (`deployment-model-wire.ts`) and product code** are unchanged.

## Must add/change

- **`PART_REWRITER`.** Python stdlib only, with no single quote.
  - **argv:** `path, nonce, part, anchor, replacement`. The TypeScript side builds `replacement` from the format table with the nonce inside it. The script checks `nonce in replacement` and exits nonzero otherwise.
  - **Read:** the archive's entries in order, each with its `ZipInfo` and bytes.
  - **Anchor count:** the part's bytes must hold `anchor` (encoded as UTF-8) exactly once, and the replace works on bytes. `ppt/slides/slide1.xml` starts with a UTF-8 BOM, and a replace on bytes keeps it. Otherwise exit nonzero before writing anything. The message names the part and the count, never the nonce.
  - **Write:** build the new archive in memory (`io.BytesIO`), with every entry in its original order and with its original content, directory entries included. Only the named part's content is replaced. Then write the bytes back with `open(path, "wb")`: the same path and inode, and no temporary file next to it, as python-docx's `Document.save(path)` does. Entry metadata (dates, compression) need not be kept; python-docx's `save` does not keep it either.
  - **Output:** print the nonce, as `REWRITER` does. The provider's `rewriteHits` counts a tool message that carries the nonce.
- **`PARTS`.** Exactly the anchors of the pinned Document Server 9.4.0 blank templates (measured 2026-11-23 from `/var/www/onlyoffice/documentserver/document-templates/new/en-US/new.{xlsx,pptx}` in `onlyoffice/documentserver:9.4.0`):
  - `xlsx`: part `xl/worksheets/sheet1.xml`.
    - anchor `<sheetData/>`;
    - replacement `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>NONCE</t></is></c></row></sheetData>`.
  - `pptx`: part `ppt/slides/slide1.xml`.
    - anchor: the subtitle placeholder's empty paragraph start, `<p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>`, which occurs once;
    - replacement: that anchor followed by `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>NONCE</a:t></a:r>`.
  - `READER` reads every element whose local name is `t`, so the nonce shows up in both parts' `texts`.
  - The nonce is `NONCE_PATTERN`-shaped (uppercase hex after `EDITOR`), so it needs no XML escaping.
- **`rewriteArgv(name, nonce)`.**
  - `.docx` → `['python3', '-c', REWRITER, path, nonce]`, exactly as today.
  - `.xlsx` / `.pptx` → `['python3', '-c', PART_REWRITER, path, nonce, part, anchor, replacement]`.
  - Any other extension throws.
  - `path` is `${WORK}/${name}`. The typing case keeps calling it with its DOCX name.
- **`CASES`:**

  ```text
  { id: 'clean',   name: '干净改写.docx',   ext: 'docx', typeFirst: false }
  { id: 'unsaved', name: '未保存改写.docx', ext: 'docx', typeFirst: true  }
  { id: 'xlsx',    name: '干净改写.xlsx',   ext: 'xlsx', typeFirst: false }
  { id: 'pptx',    name: '干净改写.pptx',   ext: 'pptx', typeFirst: false }
  ```

- **`freshFile(lane, case, nonce)`**, exported from the new module. `case` is `{ id, name, ext }`, and `nonce` is the case's Agent nonce (`lane.rewrites[index].nonce`; for the typing case, its `nonces.agent`).
  - The lane is typed structurally as `ArchiveLane & { run: DockerOutput }`: `exec`, `session` (for `documentServerReady`) and `run`. The new module never imports `OfficeRewriteLane`, which would make an import cycle with the rewrite fixture. A stand-in lane drives it directly.
  - `PARAGRAPH` (fixture `:51`) moves with it.
  - `TYPING` gains `ext: 'docx'`, and `typingCase` calls `freshFile` in place of `freshDocx` (fixture `:730`).
  - `docx`: as today. `docxCommand(name, PARAGRAPH)`; the first read's `{ sha256, text: texts['word/document.xml'] }` equals `{ written.sha256, PARAGRAPH }`.
  - `xlsx` / `pptx`: the template's base64 from the Document Server (the shared helper: `run(['exec', DOCUMENT_SERVER, 'base64', '-w0', `${TEMPLATES}.${ext}`])`), written with `docxCommand(name, '--base64', base64)` as the editor lane's `writeArgv` does. The first read's `{ sha256, agent }` must equal `{ written.sha256, false }`, where `agent` says whether any part already holds the case's Agent nonce.
  - Then `documentServerReady`, as today.
- **`EXPECTED_REWRITE`:** `xlsx: CLEAN` and `pptx: CLEAN` (the prediction; see § Measurement).
- **Screenshots:** `office-rewrite-xlsx-open.png`, `-saved`, and the same for `pptx`, from the existing `shots` rule.
- **The configured-scripts check** expects `[[0, 0, 0, 0], [0, 0, 0, 0]]`. A lane configured with fewer scripts fails it.

## Budget

Each new case is accounted as the existing ledger accounts a DOCX clean case:

- **#442 (690 s):** six waits at one 60 s session timeout (the healthcheck wait, the editor load, the Agent turn, the save's typing, the save poll, the notice clear), two 15 s windows, and ten 30 s execs (the write, four reads, two provider reads, three listings);
- **#650:** 190 s;
- **#657 A:** 75 s;
- **the template read:** one 30 s exec.

That is 985 s per case, so the A4 line adds 1970 s:

- the Sum line gains `+ 1970 = 12050s`, "the 1200s of cold builds plus 10850s";
- `testTimeout: 12_050_000`;
- the deadline-only note at `vitest.config.ts:112-114` names #657 A4 alongside #442 and #652, because the healthcheck wait is counted the same way.

## Measurement

The DOCX values come from §60's runs. The XLSX and PPTX values are predictions:

- the plugin refetches config once (`refreshFile`) for every format;
- the Document Server reopens the rewritten XLSX or PPTX;
- the employee's typing lands in a different cell or shape from the Agent's nonce.

So step 2.1 runs the stack on the implementation commit (`STACK_ONLY`) before the head is frozen.

- **The facts equal `CLEAN`:** proceed.
- **They differ:** stop and report the observed facts to the user. A different value is either a product finding (for example, the plugin does not refresh a spreadsheet editor) or a fixture error, and the user decides. The expected values are never edited to match a run on the agent's own judgement.

## Governing invariant

- **Same assertion shape:** an Agent rewrite of an open, clean XLSX or PPTX is asserted with exactly the facts of the DOCX clean case.
- **Real rewrite:** the rewrite changes the file in place, or fails loudly and leaves the file untouched. It never succeeds without the nonce in the file.

## Sibling surfaces

- **`writeArgv` in the editor fixture** stays as it is. The rewrite lane calls `docxCommand` with `--base64` directly, the same writer.
- **The external lane's "XLSX and PPTX rest on the plugin source"** (README:92) is a different lane and is not touched.
- **Comments that say "DOCX" for every case** are updated so that they name the format where it matters: the fixture's `:52` and `:773-784`, and `platform-stack.stack.test.ts:552`.
- **Out of scope, report only:** an unsaved XLSX or PPTX case (proposal § What Changes), and the typing case's one-instant shape (already reported in #703).

## Seams under test

- **The part rewriter, run with the host `python3`.** The CI host has it; the existing python-docx case already runs it. The test builds a small zip in a temporary directory with the entries listed in § Required evidence: a directory entry, the named part holding the anchor once (with a UTF-8 BOM in the PPTX-shaped case), and another entry that also holds the anchor. Then it runs `rewriteArgv`'s argv with `python3` and checks the result with `READER` (also run with the host `python3`).
- **`rewriteArgv` / `rewriteCommand` per extension.** The argv shape, the single-quoted command round-tripping through `sh` (as the existing quoting case does), and a throw on an unknown extension.
- **`ownedRewrites`.** Four scripts, each with its own marker and nonce, each targeting its case's file with its format's rewriter.
- **`freshFile` with a stand-in lane.** For `xlsx` and `pptx`: `run` receives exactly the template read's argv; `exec` receives `docxCommand(name, '--base64', <that base64>)`; the first-read check passes. For `docx`: no `run` call, and `exec` receives `docxCommand(name, PARAGRAPH)`.
- **The scenario with the stand-in lane** (`rewriteLane`, `:827-849`). Its three scenario cases (`:863`, `:879`, `:914`) all fail inside the clean case's session. They gain only the four-entry provider arrays, so the configured-scripts check passes as before. No stand-in drives the XLSX or PPTX case through a whole session.
- **Stack only.** Two pieces of wiring are covered only by the stack: the case's `ext` reaching `typeAndSave`, and `rewriteCase` running for indexes 2 and 3.

## Required evidence

Each mutant keeps the field and weakens only the mechanism. Record it red with its case, then green.

- **Positive.** XLSX- and PPTX-shaped archives rewritten. Each test zip holds a directory entry, the named part and another entry that also holds the anchor. The PPTX-shaped part starts with a UTF-8 BOM. After the rewrite:
  - the named part's `texts` hold the nonce, and its bytes still start with the BOM where they did;
  - every other entry's name, order and content are unchanged, including the other entry holding the anchor;
  - the inode is unchanged;
  - the directory holds no other file;
  - stdout is the nonce.
- **Mutant (a):** write to a temporary file and `os.replace` it. The inode check goes red.
- **Mutant (b):** drop the anchor-count check, so that `str.replace` replaces every occurrence, or none. Two cases go red:
  - anchor missing → it must exit nonzero and leave the bytes unchanged;
  - anchor twice → it must exit nonzero and leave the bytes unchanged.
- **Mutant (c):** replace the anchor in every entry that holds it. The other-entry check goes red.
- **Mutant (d):** `rewriteArgv` sends `.xlsx` to the python-docx `REWRITER`. The per-extension argv case goes red.
- **Mutant (e):** the configured-scripts check keeps two zeros. The scenario stand-in with four scripts goes red.
- **Mutant (f):** `freshFile` for XLSX/PPTX skips the template and writes the DOCX paragraph. The `freshFile` stand-in case goes red, because the template read is never called and `exec` receives the wrong argv.
- **Mutant (g):** drop the `nonce in replacement` check. A case passing a replacement without the nonce must exit nonzero and leave the bytes unchanged.
- **Stack:** the measuring run (2.1), then the exact-head `pnpm test:stack` (2.3), with `officeRewrite.xlsx` and `officeRewrite.pptx` in the evidence line.
