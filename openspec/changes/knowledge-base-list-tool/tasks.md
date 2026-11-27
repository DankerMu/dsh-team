## Risk packs

- **Public API (selected).** The new tool's contract: parameters, results, text and meta. Unit tests in task 1.2.
- **Auth / permissions (selected).** The scope fence: out-of-scope equals nonexistent, and no widening for children. Unit tests in 1.2 and the stack case in 1.4.
- **Concurrency / shared state (selected).** Child records are shared by both tools through one listener pair. Unit tests in 1.2; search tests unchanged in 2.1.
- **Error handling (selected).** The closed result set; the tool never throws. Unit tests in 1.2.
- **Legacy compatibility (selected).** `knowledge_base_search` is unchanged. Existing tests unmodified except the one allowed change (`index-search.test.js:122` becomes the two-name list, search registered first), in 2.1.
- **Documentation (selected).** README, LOCAL_STACK and the baseline's F49. Task 1.5.
- **Not selected:**
  - Config: no new configuration.
  - File IO: none.
  - Schema: no proxy or OpenAPI change.
  - Resource limits: at most two requests per call, using the existing limits.
  - Release: no dependency and no delivery change; the plugin's four delivered files are unchanged in number.

## Must preserve

- `knowledge_base_search`, byte for byte: definition including its description, results, texts, meta, timeout.
- The plugin's four delivered files, with no `package.json` `files` or Dockerfile change.
- Root and child resolution semantics, and the child record lifecycle.
- The panel routes, the scope command and projection.
- The stack lane's search and scope steps, and its five paid retrievals per run. The list case adds no retrieval.

## 1. Implementation

- [x] 1.1 Extract the scope resolver (records plus `agent/created` and `agent/disposed`) out of `searchTool`, so `knowledge_base_search` and the new tool share it.
- [x] 1.2 `knowledge_base_list` in `plugins/knowledge-base/index.js`, with `index-list.test.js` covering the design's unit evidence, red first. This includes the one-listener count and the forbidden-string check on the definition and texts.
- [x] 1.3 Register `knowledge_base_list` after `knowledge_base_search`, which stays byte for byte; only the new tool's description says when to use it. Change `index-search.test.js:122` to the two-name list, the one allowed change.
- [x] 1.4 Stack case per the design: provider wiring in `deployment-model-wire.ts`, and the case in `knowledge-search-stack-fixture.ts` or a new sibling fixture with its integration test. `platform-stack.stack.test.ts` gains only the call and stays under 800 effective lines. `forbiddenRequests` stays 0.
- [x] 1.5 Docs: plugin README (§ List tool, plus § Retrieval tool on the shared resolver), `docs/LOCAL_STACK.md` §5 step list, and `docs/REQUIREMENTS_BASELINE.md` F49 in § 5.5 dated 2026-11-27.

## 2. Verification

- [x] 2.1 `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:integration` exit 0 locally. `pnpm check:fast` fails locally only on untracked `.workplans/`. CI Fast checks and Guardrail self-test are the evidence for those two gates.
- [ ] 2.2 `pnpm test:stack` with the list case.
- [ ] 2.3 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`.
