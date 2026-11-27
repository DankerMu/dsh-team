## Why

#763: in the stage-2 manual acceptance an employee asked 「知识库有啥内容」. The Agent's only knowledge tool is `knowledge_base_search` (`plugins/knowledge-base/index.js`, `searchTool`), a semantic retrieval, so it searched that sentence, found no chunk and answered that nothing was there. Listing which libraries and files exist is the usual first step, and no tool covers it.

**Project owner's decision (2026-11-27):** add an Agent tool that lists libraries and files. It reuses the two existing proxy list routes and sees only the libraries in the current turn's retrieval scope.

## What Changes

- **New global tool `knowledge_base_list`** in `plugins/knowledge-base`, registered with `knowledge_base_search` in the same `ctx.inject(['tools', 'sessionProjections', 'agents'])` block. Child Agents inherit it; `permission-tiers` does not gate it.
- **Scope resolution is shared, not copied.** The per-child record map and the `agent/created` and `agent/disposed` listeners move out of `searchTool` into one resolver used by both tools. One listener pair, one record per child: a delegation never widens, and a child without a record answers `scope-unavailable`. This is the existing rule.
- **Behavior, parameters `{ library?, keywords?, page? }`:**
  - No `library`: lists the names of the in-scope libraries, in the proxy's order. Scope `null` means every listed library; an ID list means the listed libraries whose ID is in it.
  - With `library`: lists one page of that library's file names (`keywords` filter, `page`), with the total and page count.
  - A `library` that does not exist or is outside the scope answers `unknown-library` without saying which.
- **Requests:** only the existing `GET …/ragflow/datasets` and `GET …/ragflow/datasets/{id}/documents`, through the plugin's existing request function. No new proxy route.
- **Output:** names only, never dataset or document IDs, the token or the platform address. It is a closed `result` set and never throws.
- **Tool description:** only `knowledge_base_list`'s description tells the model to use it for what is in the knowledge base and to use `knowledge_base_search` for content. `knowledge_base_search`'s description is unchanged (divergence 4).
- **Baseline:** new F49 in `docs/REQUIREMENTS_BASELINE.md` § 5.5: the Agent can list the knowledge bases in the current scope and their file names (project owner's decision 2026-11-27).

### Divergences from issue #763

1. **No file counts in the no-`library` answer.** The proxy's `GET datasets` answer has only `id` and `name`. A count would need one documents request per in-scope library, up to 1000. The no-`library` answer gives names only, and the count comes with the per-library answer (`total`).
2. **F49 goes in § 5.5.** The issue says "after F25", but F25 sits in § 5.4. The new requirement goes in § 5.5 RAGFlow, where every other knowledge-base requirement lives.
3. **Whole-scope stack assertion.** The issue asks for "lists 3 libraries" under the whole scope. The local RAGFlow may hold libraries besides the seeds (the panel stack fixture assumes the same). So the assertion is "includes the three seed names".
4. **`knowledge_base_search`'s description is unchanged.** Only the new tool's description says when to use it. That keeps the search tool byte for byte.

## Impact

- `plugins/knowledge-base/index.js`: shared resolver, list tool and registration. It stays in `index.js` (about 530 effective lines against `max-lines` 800, blank lines and comments skipped). The user image delivers exactly the plugin's four files (`images/dsh-user/Dockerfile`, `package.json` `files`, `user-image.docker.test.ts`), so no new module, no delivery change, and no import cycle.
- Tests: `index-search.test.js` (one allowed change, see design), a new `index-list.test.js`, `types.d.ts`, and `README.md` § Retrieval tool plus a new § List tool.
- Stack: the list case lives in `platform/test/knowledge-search-stack-fixture.ts` or a new sibling fixture module, with only its call added to `platform-stack.stack.test.ts`, which is near its 800-line limit. Also `platform/test/deployment-model-wire.ts` (the provider's scripted calls) and `docs/LOCAL_STACK.md` §5.
- `docs/REQUIREMENTS_BASELINE.md` (F49), `openspec/specs/knowledge-base/spec.md` (delta).

## Triage

```text
Issue type: feature
Fixture level: expanded
Upstream suggested level: absent
Blast radius: Agent-visible tool surface and the shared scope records; a wrong resolver could widen a child's scope or break knowledge_base_search
Selected risk packs: Public API (tool contract); Auth / permissions (scope fence); Concurrency / shared state (child records); Error handling; Legacy compatibility (search tool unchanged); Documentation
Evidence floor: plugin unit tests (list tool + unchanged search tests), pnpm test:integration, pnpm test:stack list case, VPS test:docker + test:deploy
```
