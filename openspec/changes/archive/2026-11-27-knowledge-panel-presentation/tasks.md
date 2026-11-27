## Risk packs

- **Legacy compatibility (selected).** The existing states, texts, data attributes, request counts, the composer scope control and the stack lane's locators all behave as before. Covered by tasks 1.2 and 2.2 and the structural contract below.
- **Documentation (selected).** `plugins/knowledge-base/README.md` § Panel describes the presentation. Covered by task 1.3.
- **Not selected:**
  - Public API: no route or request changes.
  - Config: none.
  - File IO: none.
  - Schema: none.
  - Auth / secrets: no data reaches new places; the stack secret scan still runs.
  - Concurrency: request supersession is unchanged.
  - Resource limits: no new requests; the count comes from the existing answer's `total`.
  - Error handling: state texts and retry behavior are unchanged; only their look changes.
  - Release: no dependency.

## Must preserve

**Behavior**

- The six displays: list plus the five states loading, empty, no-match, failed and not-configured, with their exact `LIST_TEXT` and `FILES_TEXT` texts.
- The 256-byte filter refusal 「筛选词过长」 and the last-page fallback.
- 「刷新」 collapses every library.
- One request per list or library page.

**Shared helpers (output unchanged)**

- `CONTROL`, `button()`, `notice()`, `datasetsView`, `LIST_TEXT`, `FILES_TEXT`.
- `ScopePopover` and `ScopeControl` render exactly as before. The existing scope tests in `client-scope.test.js` and `client.test.js` pass unmodified.

**Structural contract for `platform/test/knowledge-panel-stack-fixture.ts` (lines 30–47, 284–301) and #762**

- The title button is a direct child: `[data-dsh-team-kb-dataset] > button`. Its textContent and accessible name are exactly the library name, so `getByRole('button', { name, exact: true })` finds it. The chevron and the count are not inside it.
- `[data-dsh-team-kb-file]` textContent is exactly the file name, and the glyph has no text. #762 attaches its click to this element.
- The filter is a `<form>` with `input[aria-label="按文件名筛选"]` and a `type="submit"` 「筛选」 button; the lane submits with Enter.
- The following stay as they are:
  - `data-dsh-team-kb-state`, `-dataset`, `-files`, `-file`, `-page`, `-datasets` and `-hint`;
  - `input[aria-label="按库名搜索"]` and the 「刷新」 button.

## 1. Implementation

- [x] 1.1 Restyle the panel per proposal.md in `plugins/knowledge-base/client.js`, with new panel constants and the shared helpers untouched.
- [x] 1.2 Unit tests in `client.test.js`, red first for each new behavior:
  - A collapsed row renders `aria-expanded=false`, the chevron outside the title button, and no files region. The title button's text equals the library name.
  - Expanded with `{ total: 2, documents: 2 }` shows 「共 2 个文件」, two file rows each with `title`, file-row text equal to the name, and no 「上一页」 or 「第 … 页」.
  - Filtered `expense` with `{ total: 1, documents: 1 }` shows 「共 1 个文件」 and no paging.
  - `{ total: 41, documents: 20 }` shows 「共 41 个文件」 and 「第 1 / 3 页」 with the paging buttons.
  - The loading, empty, no-match, failed and not-configured states show their original text and no count or paging.
  - Replace the two single-page assertions at `client.test.js:496` and `:663` (「第 1 / 1 页」) with: no paging row and 「共 1 个文件」 (proposal divergence 2). Every other existing assertion stays unmodified.
- [x] 1.3 Update `plugins/knowledge-base/README.md` § Panel for the new presentation.

## 2. Verification

- [x] 2.1 `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:integration` exit 0 locally. `pnpm check:fast` fails locally only on untracked `.workplans/`; CI Fast checks is the evidence for it.
- [x] 2.2 `pnpm test:stack` passes with its panel steps and `knowledge-panel-stack-fixture.ts` unchanged.
- [x] 2.3 Screenshots taken by the parent against a running deployment of the PR head, on the local stack's seed libraries.
  - Themes: Playwright `colorScheme: 'light'` and `'dark'` emulation. If DSH does not follow the system scheme, use its own appearance setting, and record which.
  - Five shots per theme:
    - Collapsed: at least the rows `dsh-team-seed-policies`, `-products` and `-minutes` (the local RAGFlow may hold other libraries), chevrons collapsed, no file region.
    - `dsh-team-seed-policies` expanded: 「共 2 个文件」, two rows, no paging.
    - Filtered `expense`: only `expense-policy.txt`.
    - Library search `kb-nothing`: 「没有名称匹配的知识库」.
    - Failed: Playwright `page.route` answers `api/knowledge-base.datasets` with `{"result":"unavailable"}`; after 「刷新」 the panel shows 「知识库加载失败」 with 「重试」. RAGFlow itself is never stopped for screenshots.
  - Attach them to the PR.
- [x] 2.4 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy` (non-docs change).
