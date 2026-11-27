## Design

**Change surface:**

- `plugins/knowledge-base/index.js`: `searchTool`, the `agent/*` listeners and the tool registration.
- `types.d.ts`.

**Must preserve:**

- `knowledge_base_search`: name, description, parameters, output schema, `render`, `presentationMeta`, results and timeout, byte for byte. Its tests change only as listed under Required evidence → Search tests (the one allowed change at `index-search.test.js:122`).
- The panel routes, the scope command and projection.
- The search tool's root and child resolution semantics (`plugins/knowledge-base/README.md` § Retrieval tool, "Root resolution" and "Asynchronous delegation").

**Must add:** `knowledge_base_list`.

- **Parameters:** `{ library?: string; keywords?: string; page?: integer }`, with `additionalProperties: false`.
  - `library`: non-blank by the proxy's whitespace rule, at most 256 UTF-8 bytes, matched exactly (case-sensitive) against listed names.
  - `keywords`: the proxy's rule (non-blank, at most 256 UTF-8 bytes); allowed only with `library`.
  - `page`: an integer from 1 to 999999, default 1; only with `library`.
  - Anything else answers `invalid-request` without a request.
- **Flow:**
  - Resolve the record exactly as search does. A missing record answers `scope-unavailable`; `[]` answers `no-scope`. Neither sends a request.
  - Otherwise `GET datasets`. A failure returns its result. An empty list answers `no-datasets`.
  - In-scope libraries are the listed ones (scope `null`) or the listed ones whose ID is in the scope array, in list order. None in scope answers `no-datasets`.
  - Without `library`: `{ result: 'ok', libraries: [name…] }`.
  - With `library`: if no in-scope library has that exact name, answer `unknown-library`. Otherwise `GET datasets/{id}/documents?page=&page_size=20[&keywords=]` and answer `{ result: 'ok', library, files: [name…], total, page, pages }`.
  - An empty page, or `total` 0, is `ok` with `files: []`; the text says there are no files or no matching files.
- **Results:** `ok`, `no-scope`, `scope-unavailable`, `no-datasets`, `unknown-library`, `invalid-request`, `not-configured`, `timeout`, `unavailable`, `upstream-error`. Each has a distinct Chinese text, and `render` and `presentationMeta` work as in the search tool.
- **Logs:** fixed text and the result only, never the library name, keywords or IDs.
- **Timeout:** `timeoutMs` 60000 (two requests).

**Governing invariant:** a tool call never lists or reveals a library outside the scope that the calling Agent's search would use. An out-of-scope library and a nonexistent one give the same answer.

**Sibling surfaces:**

- `knowledge_base_search` shares the resolver. The child record lifecycle (`agent/created` for startup and resume, `agent/disposed`) must register once, not once per tool.
- `permission-tiers` gating: the list is not a mutation; confirm it is not in the gated set.
- `office-agents` presets: child Agents inherit global tools, with no change.
- The proxy routes are unchanged; the list tool uses only the existing contract.

**Seams under test:**

- The `knowledge_base_list` definition's `execute` with fake `scoped` services and a fake request function (unit).
- The real DSH Agent through the deterministic provider (stack).

**Required evidence:**

- **Unit tests, red first:**
  - Root scope `[A]`, list returns `[A, B]`: `libraries: ['A']`.
  - Root scope `null`: every listed name.
  - `[]`: `no-scope`, zero requests.
  - A child created from the root while the scope was `[A]`, root then widened to `null`: the child still lists only A.
  - A child with no record: `scope-unavailable`.
  - `library: 'B'` with scope `[A]`: `unknown-library`, the same as `library: 'nope'`, with no documents request.
  - `library: 'A', keywords: 'expense', page: 2`: one documents request with those values, and the answer carries `total`, `page` and `pages`.
  - `keywords` without `library`, `page: 0`, a blank or oversized `library`, or an extra key: `invalid-request`, zero requests.
  - Each failure result maps to its own text.
  - The output text and meta contain no ID.
  - One `agent/created` listener in total, with both tools registered.
- **Search tests:** `index-scope.test.js` and every `index-search.test.js` assertion pass unmodified, with one allowed change. `index-search.test.js:122`, which asserts the registered tool names are exactly `['knowledge_base_search']`, becomes `['knowledge_base_search', 'knowledge_base_list']`. Search is registered first, because the harness takes `const [tool] = tools`.
- **Single listener:** the harness stores listeners with `listeners.set`, which would hide a second registration. So the new test counts `on('agent/created')` and `on('agent/disposed')` calls and expects exactly one of each.
- **Forbidden strings:** the provider flags any model request whose body contains `kb-scope`, `知识库范围` or a seed dataset ID (`deployment-model-wire.ts`). So the list tool's name, description, parameter descriptions and every result text contain none of these. The stack case still ends with `forbiddenRequests: 0`.
- **Stack case:** the deterministic provider has the Agent call `knowledge_base_list`.
  - Policies-only scope, no `library`: `ok` with exactly `['dsh-team-seed-policies']`.
  - Then `library: 'dsh-team-seed-policies'`: the two seed file names, total 2.
  - Whole scope: the three seed names are included (other local libraries may exist).
  - The native `tool/result` holds no ID. Console errors are 0 and outbound requests are 0.

**Non-goals:**

- File counts in the no-`library` answer (see the proposal's divergence).
- Listing document contents; that is #762's preview, which is browser-only.
- Changing which tool the model picks beyond the descriptions.

**Review focus:**

- Scope fence and child-record sharing, with no widening.
- The search tool unchanged byte for byte.
- No IDs in outputs or logs.
- The 800-line limit for `index.js` and `platform-stack.stack.test.ts`. Canonicality: one resolver, no duplicated parsing.
