# Knowledge base

This dependency-free host plugin and classic-script Web client support **DSH `0.2.1-rc.2`** through the manifest range `engines.dsh: >=0.2.1-rc.2 <0.3.0`; the manifest declares no `@deepseek-ai/dsh` peer. It will give employees the 「知识库」 sidebar panel, the composer scope control and the retrieval tool over the platform's RAGFlow proxy (stage 2, group 15).

## Scope

15.1 delivered the skeleton, the image delivery and the catalog registration; 15.2 adds the 「知识库」 panel. The composer scope control (15.3) and the retrieval tool (15.4) come later.

- The plugin code, manifest and patch hold no RAGFlow address, key or retrieval parameter. The RAGFlow key stays in the platform backend; the plugin only ever talks to the platform, and the browser only ever talks to this instance's own DSH routes.

### Availability

The plugin is usable on an instance only when the overlay gives a valid `{ platformUrl }` (below) **and** `DSH_TEAM_INSTANCE_TOKEN` is exactly 64 lowercase hex characters. The host half (`index.js`, plugin name `dsh-team-knowledge-base`, `inject = ['connection']`) publishes the page global `__DSH_TEAM_KNOWLEDGE_BASE__ = { available }` through the released `webserver/index-inject` row in both cases, as `platform-nav` publishes its own. Without an address (`published-loopback`, an employee's older overlay) or without a valid token it registers no route and publishes `{ available: false }`; the client then registers no panel and sends no request. The token never reaches the page global, a log line or an answer.

### Host routes

When available, the host half registers two exact `GET` routes on DSH's shared `/api` channel through `ctx.connection.fetch.register` (DSH authenticates the browser before the handler runs: 401 unauthenticated, 403 untrusted Host/Origin or a non-owner Peer):

- `GET /api/knowledge-base.datasets` takes no query; any query string, even a bare `?`, or a fragment answers `invalid-request` without a platform request. It forwards to `<platformUrl>/_platform/instance-api/ragflow/datasets`.
- `GET /api/knowledge-base.documents?datasetId=<32 lowercase hex>&page=<1..999999>&pageSize=<1..100>[&keywords=…]` parses its raw query as strictly as the platform proxy: percent-decoded, `+` as a space, and an unknown, repeated, valueless or undecodable item, a fragment, or blank (U+0085 included) or over-256-UTF-8-byte `keywords` answer `invalid-request` without a platform request. It forwards to `<platformUrl>/_platform/instance-api/ragflow/datasets/<id>/documents?page=&page_size=[&keywords=]`.

Each platform request sends `Authorization: Bearer <DSH_TEAM_INSTANCE_TOKEN>` with `redirect: 'manual'`, has one 25-second deadline through the end of the body and a 2 MiB body limit (a parameter of the request function), is never retried, and is aborted when the browser disconnects or the plugin is disposed. Both routes always answer HTTP 200 with `content-type: application/json` and `cache-control: no-store`, and a closed body: `{ result: 'ok', datasets: [{ id, name }] }`, `{ result: 'ok', total, documents: [{ id, name }] }` or `{ result }` with `not-configured`, `unavailable`, `timeout`, `upstream-error` or `invalid-request`. A platform 200 whose body passes the plugin's shape check is forwarded with only those fields, and the platform's own `result` passes through; a 3xx, 401 or other non-200, an oversized, unparseable or malformed body is `upstream-error`; a transport failure is `unavailable`; the deadline is `timeout`. Logs carry fixed text and the result only (a 401 adds one fixed line about the instance token), never `keywords`, the token, the platform address or a body.

### Panel

DSH 0.2.1 has no content slot in the left sidebar, so the panel follows the released panels (定时任务): the client (`client.js`, `inject: ['slots']`, React from the runtime seed) registers one `sidebar.panellist` row `{ id: 'knowledge-base', order: 20, label: () => '知识库' }` with an inline SVG glyph and a `main` page under the same key, which `layout.selectPanel` requires. The manifest's `dsh.client.inject` therefore also names `@deepseek-ai/dsh-client-ui-layout`. All texts are fixed Chinese; the page uses plain DOM elements and DSH's CSS variables.

The page lists the libraries, filters them by name on the client (case-insensitive substring, ignored when blank), and expands a library into its files, 20 per page with 「上一页」/「下一页」 and 「第 x / N 页」, filtered by file name through `keywords` (Enter or 「筛选」, back to page 1; a blank filter of any length clears it; any other over 256 UTF-8 bytes is refused with the separate hint 「筛选词过长」 and no request). 「刷新」 reloads the list and collapses every library. Every region carries `data-dsh-team-kb-state`: `loading`, `not-configured` (「知识库未配置」, without a list, search or retry; 「刷新」 stays so the list loads once RAGFlow is configured), `failed` (any other failure, with 「重试」), `empty`, `no-match` and `list`, each with its own text. An empty page past the end of a positive total falls back once to the last page. The list and each library hold at most one request: a new one aborts the previous, and a superseded answer is dropped even when its request ignored the abort and answers last. Every answer body is read before the panel changes. Browsing reads and writes no Session or scope data.

## Config contract

The bundle patch (`cordis.patch.yml`) is exactly one insert row, `{ id: knowledge-base, name: /opt/dsh-team/knowledge-base/index.js }`, without `config` or override rows. The managed overlay (#447) targets that id with `{ id: 'knowledge-base', config: { platformUrl } }` in network mode.

- No platform address is a designed state, not an error: a `config` that is `undefined`, `null` or a plain object without own keys registers no route and publishes `{ available: false }`. This is the state in `published-loopback` mode, where the overlay writes no `knowledge-base` config row; in network mode the overlay always gives `platformUrl` (#447).
- With an address, `config` is exactly `{ platformUrl }`: the string `http://<canonical dotted IPv4>:<port>`, whose last octet is 3 modulo 16 (the instance bridge's +3 platform address, the same rule the generator applies to +2), with a decimal port 1..65535 without leading zeros, and no path (a trailing `/` included), query, fragment or user information.
- Any other shape (an extra or symbol key, a non-string or accessor value, a malformed or non-+3 address, an array or a non-plain object) makes `apply` throw a `TypeError` with a fixed message that does not echo the input, before it touches the host context. The whole plugin then fails to load, which the existing plugin-failure marker checks report, as with a tampered `platform-nav` row.

The row name is an absolute `/opt` path rather than the package name: when the overlay forces the entry on in a profile without its registered copy (a home volume created before stage 2, or one whose copy an employee uninstalled natively), it writes this whole patch, and only the absolute path resolves there, to the root-owned canonical copy; the adjacent manifest still delivers the client half.

## Trusted delivery

Build the user image with all five narrow plugin named contexts:

```sh
docker build -f images/dsh-user/Dockerfile -t dsh-team-user \
  --build-context "zh-locale=$(pwd)/plugins/zh-locale" \
  --build-context "permission-tiers=$(pwd)/plugins/permission-tiers" \
  --build-context "office-agents=$(pwd)/plugins/office-agents" \
  --build-context "platform-nav=$(pwd)/plugins/platform-nav" \
  --build-context "knowledge-base=$(pwd)/plugins/knowledge-base" images/dsh-user
```

The image copies `package.json`, `index.js`, `client.js` and `cordis.patch.yml` to root-owned mode `0444` files in the mode `0555` directory `/opt/dsh-team/knowledge-base/`, outside the employee-writable `/data/home`. The catalog lists it as the manageable item `knowledge-base` (「知识库」) with `imageDefaultEnabled: true`, so `catalog-check.mjs register` copies it into the Web profile as the installed dependency `file:/opt/dsh-team/knowledge-base` and appends it to `dsh.profile.bundles` in catalog order, before the office bundle. The build fails unless the installed DSH satisfies `engines.dsh` and the profile copy equals the canonical copy byte for byte. Its enablement follows only the catalog's three states: `employee` (the default) leaves the employee's plugin-page switch in charge, and the overlay's catalog rows force `forced-on`/`forced-off` (#407).

Legacy home volumes: Docker seeds the profile only into an empty home volume. An employee whose home volume existed before this image has no registered copy and no bundle membership, so in the `employee` state they have no knowledge base until an administrator resets their profile, like the office bundle. `forced-on` loads it on those volumes through the absolute path row.

## Verification

- `pnpm test`: `index.test.js` (the plugin name and `inject`; the availability matrix of address and token against registered routes and the page global; a fixed `TypeError` without the input, before any host use, for every rejected config shape; valid and invalid query strings of both routes, with no platform request for the invalid ones; the forwarded URL, method, `Authorization` and `redirect`; every answer mapping, the 2 MiB limit, the 25-second deadline through the body, browser disconnection and disposal; no keywords, token, address or body in the logs; the manifest and the single config-free insert row) and `client.test.js` under jsdom with `react-test-renderer` (registration only for a literal `available: true`, with one key for the row and the page; the six list displays and the six library displays with distinct texts, retry, refresh collapsing, paging bounds, filter submission back to page 1, blank (including blank over 256 bytes) and over-long filters, refresh out of not-configured, the one-shot past-end fallback, superseded answers aborted and, when a request ignores its abort and answers last, dropped, only `api/knowledge-base.*` requested and every body read). Real data never reaches a second page (each seed library holds two files), so paging is proved here.
- `pnpm test:stack` (local, Playwright Chromium through the gateway against the seeded RAGFlow stack): 「知识库未配置」 for a second employee before RAGFlow is configured, a retryable failure (and a failing retry) while RAGFlow is stopped, and after it is back the seed libraries, one library's two files, the `expense` file filter and a no-match library search, each with a `kb-*.png` screenshot and zero console, page, failed or external requests. In each panel session no DSH document, script or `api/knowledge-base.*` answer carries the saved RAGFlow address or key, the instance token or the platform address, and the scan must have seen the document with the page global, the client script and a route answer.
- `pnpm test` and `pnpm test:integration`: the catalog consumers (`catalog-check`, the catalog module, the administrator catalog API, the build-rejection contexts and the plugin-page evidence module) on the five-entry catalog.
- `pnpm test:docker` on giap-vps: `/opt/dsh-team/knowledge-base/` holds exactly the four files, root-owned and read-only, which uid1001 cannot write, create or rename; the manifest is compatible and peer-free with a `./client` export; the profile bundles are `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @dsh-team/knowledge-base, @dsh-team/office-agents]`; the managed-policy instance's exact boot roster includes `@dsh-team/knowledge-base`, its logs carry no plugin-failure marker and its loader holds the `knowledge-base` row enabled and active; the first-use plugin page shows the knowledge-base card `running` with its switch visible; stored RAGFlow sentinels appear neither in the instance environment, its overlay, the canonical files nor the profile copy.
