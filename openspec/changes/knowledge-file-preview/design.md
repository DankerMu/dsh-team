## Design

**Change surface:**

- `platform/src/ragflow-proxy/routes.ts`: new route, query parser, schemas.
- `platform/src/ragflow-proxy/client.ts`: `listRagflowChunks`.
- `plugins/knowledge-base/index.js`: host route `knowledge-base.chunks`.
- `plugins/knowledge-base/client.js`: the preview view.

**Must preserve:**

- The four existing proxy routes: paths, schemas, results, validation, the log redaction, and `exposeHeadRoute: false`.
- The auth hook covering every path under the prefix.
- The two existing host routes.
- The panel after #761: states, texts, structural contract, request counts.
- The composer scope control.
- The stack lane's existing panel, scope and search steps and its five paid retrievals. The preview uses no retrieval.

**Must add:**

- **Proxy route:** `GET datasets/{id}/documents/{documentId}/chunks`.
  - `id` and `documentId` are 32 lowercase hex characters.
  - Query: exactly `page` (1..999999) and `page_size` (1..100), parsed strictly like the documents route. Unknown, repeated, malformed or `#`-bearing queries are `invalid-request` before any settings read.
  - Empty address or key is `not-configured` without an outbound request.
  - Upstream `GET /api/v1/datasets/{id}/documents/{documentId}/chunks?page=&page_size=`, with `RAGFLOW_TIMEOUT_MS` and an 8 MiB body cap.
  - Validation: `code` 0, `data.doc.id === documentId`, `data.doc.dataset_id === id`, `data.total` a non-negative integer, and `data.chunks` an array of at most `page_size` entries, each with a string `content_with_weight`. The answer's `content` is that string.
  - Answer: `{ result: 'ok', total, chunks: [{ content }] }`. A page past the end is `ok` with `[]`.
- **Host route:** `GET /api/knowledge-base.chunks?datasetId=&documentId=&page=&pageSize=`. Strict parsing as in `knowledge-base.documents`: unknown, repeated, valueless or undecodable items or a fragment are `invalid-request` with no platform request. It answers HTTP 200 with `cache-control: no-store` and a shape-checked body (`{ result, total?, chunks? }`), uses the same request function, deadline and LIST_LIMIT, and logs fixed text only.
- **Preview view:** see the proposal.
  - The chunk text is rendered as React text children, never `dangerouslySetInnerHTML`.
  - Page size is 20 chunks.
  - One request at a time; a new page aborts the previous request and a superseded answer is dropped, as the files view does.
  - 「返回列表」 restores the library list with the same libraries expanded and the same filter and page.

**Governing invariant:** the preview only ever shows parsed text of the requested document in the requested library, read through the instance-token proxy. Nothing writes to RAGFlow and nothing returns the original file.

**Sibling surfaces:**

- `listRagflowDocuments`: share its validation helpers; no duplicate entry parsing.
- The OpenAPI generator.
- The `routerPath` / auth hook, which already covers the prefix; confirm it covers the new path.
- The request-log serializer's query redaction.
- `knowledge-panel-stack-fixture.ts`: the snapshot shape and the secret scan, whose `PANEL_ROUTES` set must include the new route so its answers are scanned.
- `ragflow-stack-fixture.ts`: proxy calls from inside the instance.

**Seams under test:**

- Proxy: `routes.test.ts`, `client.test.ts` (fake upstream), and `platform/test/ragflow-proxy-chunks.integration.test.ts`.
- Plugin: `index.test.js` for the host route, `client.test.js` for the view.
- Stack: the real panel against the seeded RAGFlow.

**Required evidence:**

- **Proxy unit tests, red first.** Fake-upstream rows use rc2's real shape, `{ chunk_id, content_with_weight, docnm_kwd, … }`, never the stale reference example.
  - ok with 2 rows (`total` 2) returns `chunks: [{ content }]` only.
  - A page past the end is `ok []`.
  - `doc.id` ≠ `documentId` is `upstream-error`, and so is `doc.dataset_id` ≠ `id`.
  - A row without a string `content_with_weight`, or more rows than `page_size`, is `upstream-error`.
  - HTTP 200 with `code` 403 is `invalid-request`, and with `code` 404 too.
  - HTTP 500 with `code` 500 (missing document or library) is `upstream-error`. Another non-zero code with HTTP 200 is `upstream-error`.
  - Not configured: no request. Timeout: `timeout`. Connection refused: `unavailable`. Body over the cap: `upstream-error`.
  - A bad id or documentId, `page_size` 101, an unknown or repeated query item: `invalid-request` with zero upstream calls.
  - An invalid token: 401. HEAD: 404.
  - The request log shows `?[redacted]`.
- **Integration test.** `platform/test/ragflow-proxy-chunks.integration.test.ts`, in the documents integration test's pattern, covers ok, ownership mismatch, the auth refusal and the redaction.
- **Contract:** `pnpm contract:check` passes after `pnpm contract:write`.
- **Plugin tests:**
  - Host route parsing: an ok forward, each invalid shape, a malformed platform body as `upstream-error`.
  - View:
    - Clicking a file row requests page 1 and shows the chunks as text; an HTML-looking chunk `<b>x</b>` renders literally.
    - Empty, failed with 「重试」, and not-configured each show their own text.
    - Paging appears only when `total` is over 20.
    - 「返回列表」 restores the expanded state.
    - The scope projection is never written.
- **Stack case:**
  - In `dsh-team-seed-policies`, click `expense-policy.txt`. The preview shows the file name and its chunk text, which contains a phrase of the seed file `scripts/seed-stack.mjs` uploads. Take a screenshot.
  - 「返回列表」 returns to the list.
  - Console errors, page errors, failed requests and outbound requests are all 0, and the secret scan covers the chunks route answers.
  - The outage case uses a Playwright `page.route` answer of `{"result":"unavailable"}` for `api/knowledge-base.chunks` only: opening a preview shows 「失败可重试」, and a screenshot is taken. RAGFlow is not stopped for it.
  - Placement:
    - The preview steps and the outage stub run inside the existing `restoredPanel` session; no new session, `PanelEvidence` field or `converse` change.
    - The panel assertions now inline in `platform-stack.stack.test.ts` (the steps, file counts and screenshots `toEqual` block) move into one helper exported from `knowledge-panel-stack-fixture.ts`. That helper asserts the new steps too, and the stack test calls it.
    - This move is the one allowed change to `platform-stack.stack.test.ts`, and it leaves the file shorter, under 800 effective lines.

**Non-goals:**

- Original-file download or rendering (PDF or DOCX layout).
- Chunk images.
- Search inside the preview.
- An Agent tool for previews.
- Any write.
- Hiding disabled chunks (proposal divergence 3).
- Changing the shared `classify` (proposal divergence 1).

**Review focus:**

- Ownership validation: the document-level `doc.id` and `doc.dataset_id` checks.
- Strict query parsing parity with the documents route.
- No HTML injection.
- The secret scan covering the new route.
- File size limits: `routes.ts`, `client.ts`, `client.js` and the stack fixture stay under 800 effective lines. Split modules only inside the platform; a new plugin client file would change image delivery and is avoided.
