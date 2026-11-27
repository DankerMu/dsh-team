## Why

#762: in the stage-2 manual acceptance the project owner could see file names in the 「知识库」 panel but not their content, so an employee cannot judge whether a file is the one they need, or check a retrieval source.

**Project owner's decision (2026-11-27):** add a read-only preview. The proxy gains a fifth read-only endpoint, and baseline F26 and F27 are revised accordingly. Acceptance 7 (no write operations, no write-back of originals) is unchanged.

## What Changes

- **Proxy:** new `GET /_platform/instance-api/ragflow/datasets/{id}/documents/{documentId}/chunks?page=&page_size=` in `platform/src/ragflow-proxy/`.
  - The same instance-token authentication, query redaction in request logs, HTTP 200 with a closed `{ result }` body, a single deadline, a body cap, and no retry or redirect, as the existing routes.
  - Upstream: one RAGFlow rc2 `GET /api/v1/datasets/{id}/documents/{documentId}/chunks?page=&page_size=` (read-only, parsed chunks; never the original file).
  - Answer: `{ result: 'ok', total, chunks: [{ content }] }`, where `content` is rc2's `content_with_weight`. rc2 v1.0.0-rc2 (Go, `internal/service/chunk/chunk.go`) sends `content_with_weight` and `chunk_id` per row and no `content` or `document_id`; `http_api_reference.md` § List chunks is stale.
  - Ownership is checked at document level: `data.doc.id` must be the requested document and `data.doc.dataset_id` the requested library, or the whole answer is `upstream-error`. rc2 filters the rows by `doc_id` itself, and the rows carry no document field to check.
  - Status mapping:
    - An existing document in a library the key cannot access answers HTTP 200 with `code` 403 or 404, which is `invalid-request` through the existing `DOCUMENT_CODES`.
    - A missing document, a document of another library, or a missing library answers HTTP 500, which the shared `classify` reports as `upstream-error`.
    - Any other non-zero code is `upstream-error`. Other fields are dropped.
  - Declared schemas; `schemas/openapi.json` regenerated.
- **Plugin host route:** `GET /api/knowledge-base.chunks?datasetId=&documentId=&page=&pageSize=` in `plugins/knowledge-base/index.js`, parsed as strictly as the existing `documents` route, forwarding to the new proxy route.
- **Panel:** clicking a file row (`[data-dsh-team-kb-file]`, the hook #761 kept) opens a read-only preview of that file inside the 「知识库」 page.
  - It shows the file name and a back link 「返回列表」, the chunk texts in order as plain text (never HTML), and paging when there is more than one page.
  - It has loading, empty (「该文件没有可预览的内容」), failed-retry and not-configured states.
  - It has no edit, download or upload entry, and copying a chunk's text is ordinary browser selection only.
  - Browsing the preview does not change the retrieval scope.
- **Baseline:** F26 becomes five read-only interfaces (adds 文件内容预览), and F27 adds read-only preview of parsed content. Both are dated 2026-11-27, citing the project owner's decision.

### Divergences from issue #762

1. **Missing library or document.** The issue lists 「库或文件不存在（`invalid-request`）」. rc2 answers that case with HTTP 500, and the shared `classify` maps every non-2xx to `upstream-error` without reading the body. Changing `classify` would move the other four routes' behaviour, so the case stays `upstream-error`; the panel shows 「失败可重试」 either way. Only the inaccessible-library case (HTTP 200, code 403 or 404) is `invalid-request`.
2. **No per-chunk ownership check.** The issue asks for "逐条校验每个分块属于请求的库和文件". rc2 rows carry no document or library field, so the check is at document level (`doc.id`, `doc.dataset_id`), as stated above.
3. **Disabled chunks are shown.** rc2 lists chunks an administrator disabled for retrieval unless `available` is sent. The preview shows the file's parsed content as RAGFlow holds it, disabled chunks included, and does not send `available`.
4. **The RAGFlow-outage preview uses a stub.** In the stack lane's real stop window the library list already fails, so no file row can be clicked. The outage case injects a Playwright `page.route` answer of `{"result":"unavailable"}` for the chunks host route only. The real `unavailable` path is proven by the proxy tests.
5. **PR size.** Proxy, contract, plugin, stack and docs together are expected to exceed 400 changed lines, mostly tests and the generated contract. The PR carries `diff-limit-exempt` with that justification. It is not split, because the preview is only usable end to end.

## Impact

- `platform/src/ragflow-proxy/routes.ts`, `client.ts`, `README.md` and their tests; `schemas/openapi.json`.
- `plugins/knowledge-base/index.js`, `client.js`, `client.types.d.ts`, `types.d.ts`, `README.md` and the tests.
- `platform/test/knowledge-panel-stack-fixture.ts` (+ integration test), `platform/test/ragflow-proxy-chunks.integration.test.ts` (new, in the pattern of `ragflow-proxy-documents.integration.test.ts`), `platform/test/platform-stack.stack.test.ts` (its panel assertion block moves into a helper exported from the panel fixture; the file gets shorter), `docs/LOCAL_STACK.md` §5.
- `docs/REQUIREMENTS_BASELINE.md` F26 and F27; specs `ragflow-proxy` (RENAMED and MODIFIED requirement, Purpose line) and `knowledge-base` (ADDED).
- Depends on #761 (both change the panel); this branch starts after #761 merges.

## Triage

```text
Issue type: feature
Fixture level: expanded
Upstream suggested level: absent
Blast radius: a new read surface over RAGFlow behind the instance token; a wrong validation could leak another library's content or expose an original
Selected risk packs: Public API (proxy route, host route, OpenAPI); Auth / permissions (instance token, ownership checks); Resource limits (body cap, page size); Error handling (closed result set); Schema (contract); Legacy compatibility (four existing routes and the panel); Documentation (baseline, READMEs, LOCAL_STACK)
Evidence floor: proxy unit and integration tests, plugin unit tests, pnpm test:integration, pnpm contract:check, pnpm test:stack preview case, VPS test:docker and test:deploy
```
