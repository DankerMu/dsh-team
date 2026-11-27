## Risk packs

- **Public API (selected).** The new proxy route, host route and OpenAPI entry. Tasks 1.1, 1.2, 1.3.
- **Auth / permissions (selected).** The instance token on the new path, and the document and library ownership checks. Task 1.1 tests.
- **Resource limits (selected).** The 8 MiB body cap, `page_size` 1..100, at most `page_size` chunks. Task 1.1 tests.
- **Error handling (selected).** The closed result set and rc2 code mapping. Tasks 1.1 and 1.3.
- **Schema (selected).** Declared schemas and `pnpm contract:check`. Tasks 1.1 and 2.1.
- **Legacy compatibility (selected).** The existing four routes, two host routes, the panel after #761 and the scope control are unchanged. Existing tests stay unmodified except where a test enumerates routes; each such change is named in the PR. Tasks 1.1 to 1.3 and 2.1.
- **Documentation (selected).** Baseline F26 and F27, the proxy and plugin READMEs, LOCAL_STACK §5. Task 1.5.
- **Not selected:**
  - Config: no new setting; it reuses the RAGFlow connection settings.
  - File IO: none.
  - Concurrency: one request at a time per view, using the existing supersession pattern, covered under task 1.3.
  - Release: no dependency and no image delivery change.

## Must preserve

- The four existing proxy routes and their tests; the auth hook; the log redaction.
- The two existing host routes; the panel (#761's structural contract); the composer scope control.
- The stack lane's existing steps and its five paid retrievals per run.

## 1. Implementation

- [x] 1.1 Proxy route and `listRagflowChunks`, with unit tests and `platform/test/ragflow-proxy-chunks.integration.test.ts` per the design's required evidence, red first, on rc2's real row shape and status mapping.
- [x] 1.2 `pnpm contract:write` and commit `schemas/openapi.json`.
- [x] 1.3 Host route `knowledge-base.chunks` and the preview view in the plugin, with tests per the design, red first.
- [x] 1.4 Stack case per the design, covering:
  - the panel fixture and its integration test;
  - `PANEL_ROUTES` covering the new route;
  - the `page.route` outage stub;
  - the preview and outage steps run inside `restoredPanel`;
  - the one allowed change to `platform-stack.stack.test.ts`: its panel assertion block moves into a helper exported from the panel fixture, so the file gets shorter.
- [x] 1.5 Docs:
  - `docs/REQUIREMENTS_BASELINE.md` F26 (five interfaces) and F27 (read-only preview), dated 2026-11-27;
  - the `openspec/specs/ragflow-proxy/spec.md` Purpose line, which says 四个 and becomes 五个;
  - `platform/src/ragflow-proxy/README.md`;
  - `plugins/knowledge-base/README.md` (§ Host routes, § Panel);
  - `docs/LOCAL_STACK.md` §5.

## 2. Verification

- [x] 2.1 `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` and `pnpm contract:check` exit 0 locally. `pnpm check:fast` and the guardrails' format clean-tree case fail locally only on untracked `.workplans/`; the other 189 guardrail cases pass. CI Fast checks and Guardrail self-test are the evidence for those two gates.
- [x] 2.2 `pnpm test:stack` with the preview case. Passed on 120236c (code tree identical to the merged head), 1097.22 s, with the preview, preview-unavailable and past-the-end steps.
- [x] 2.3 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`. Passed on 019b865: custody 145 tests with cleanup confirmed, deploy 14 tests, clean host fence.
- [x] 2.4 The PR carries `diff-limit-exempt` with the justification in proposal divergence 5, if it exceeds 400 changed lines.
