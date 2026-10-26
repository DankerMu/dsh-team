## Change surface

- A new route plugin under `platform/src/admin/`, plus a sibling unit test. It is registered by `adminRoutes` as its own plugin, not inside `modelConfigRoutes`, because that plugin's error handler rewrites 400s to "Invalid model configuration".
- A probe module, with a sibling unit test, that owns URL building, the outbound request and classification.
- **Shared extractions.**
  - The empty-JSON-body validator and the 400/413/415 error mapping, now private to `admin/instance-actions.ts:20-83,183-188`, move to one shared admin module, with its own sibling test, that `instance-actions.ts` and the new route both import. Behaviour stays identical.
  - The settings→model-settings mapping in `orchestrator/instance-service.ts:63-74,126-133` (`apiKeyEnv: 'DSH_TEAM_MODEL_API_KEY'`, `apiKeyConfigured: modelApiKey.trim() !== ''`) moves to `managed-config` with one exported constant. The mapping takes a `Settings` value, not a database handle, so `managed-config` keeps its type-only `db` import. `instance-service.ts` and the probe both use it. This is a minimal diff under `platform/src/orchestrator/`, a critical path, and needs human line review.
- `platform/web/src/model-page.tsx` and its existing helpers: the test button, the result text and the address help text.
- `schemas/openapi.json`, regenerated.
- New integration and UI tests.
- `AGENTS.md`, `docs/DEPLOY.md` and the `admin-console` spec.

## Must preserve

- **Model-config GET/PUT.** Their schemas and behaviour are unchanged, and they still never contact the model. The key is never returned, and an omitted key still keeps the stored one.
- **Existing model page.** Save, refresh, key status, validation, restart-all confirmation, the pending fence, and 401/403 handling. All existing assertions in `admin-models*.ui.test.ts` and `model-page.test.tsx` stay unmodified.
- **Transport policy.** Its real owners are unchanged:
  - Origin and JSON checks: the global onRequest hook `installRequestGuard` (`auth/request-guard.ts`).
  - The first 401/403: the `admin/routes.ts:78` onRequest hook.
  - Only the authority recheck after the body is read belongs to the new route, as in `instance-actions.ts`.
- **Instance start.** The `unconfigured` decision on the start path is unchanged. The extraction is a pure move, and the existing orchestrator tests stay green.
- **Logging.** The logger redaction configuration is unchanged. No new log line may carry the key, the upstream body or the full URL.
- **Isolation.** No change to overlay generation, the gateway, the instance lifecycle or audit event types.

## Must add/change

- **Request.** `POST /_platform/api/admin/model-config/test` with body exactly `{}`.
- **Unconfigured.** If the saved settings are incomplete, return `unconfigured` and make no outbound request. "Complete" means the same predicate overlay generation uses for `configured`.
- **URL rule.** Take the saved address exactly as stored: no trim, no relative resolution. Form `address.endsWith('/') ? address + 'chat/completions' : address + '/chat/completions'`, then parse the whole string with WHATWG `new URL()`. Only `http:` and `https:` are sent.

  An address that fails to parse, or whose scheme is not http(s), gives `invalid-address` with zero requests; `www.dmxapi.cn/v1` without a scheme is the realistic case. A key that fetch rejects as a header value (for example one containing CR/LF) gives `invalid-key` with zero requests.

  **Parity evidence**, read from the installed user image, not `resource/`:
  - `dsh-llm-pi-ai@0.2.0-rc.2` `lib/index.js:877,1113,1126` passes the provider `baseURL` through unchanged.
  - pi-ai 0.87.1 `openai-completions.js:557-563` constructs `new OpenAI({ baseURL: model.baseUrl, … })`.
  - openai@6.40.0 `client.js:137` keeps `baseURL || default`, with no normalisation.
  - `client.js:285` builds `new URL(baseURL + (baseURL.endsWith('/') && path.startsWith('/') ? path.slice(1) : path))` with path `/chat/completions`.

  Header parity (User-Agent, X-Stainless-*, provider attribution headers) and streaming parity are not claimed.

- **Outbound request.**
  - Method `POST`.
  - Headers: `Content-Type: application/json`, `Authorization: Bearer <key>`.
  - Body: `{"model":<defaultModel>,"messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}`.
  - Redirects are not followed.
  - A 20 s overall deadline, read through the end of the body.
  - At most 64 KiB of the response body is read. Anything longer is `bad-response`, never buffered without bound.
- **Cancellation and concurrency.** The route owns an `AbortController` for its outbound request.
  - **Client disconnect.** The route aborts the probe when the client disconnects before the reply. Detect this with the reply or socket `close`, not the request stream's `close`, which can fire once the body has been read.
  - **Application close.** A **preClose** hook aborts every in-flight probe. It must not be ordered after the app's pre-close response drain (Fastify `onClose` runs too late), so shutdown never waits for the deadline.
  - There is no server-side serialization, so concurrent probes from two tabs run independently.
- **Logging.** On failure, log one fixed message plus the result code only, never `error.message` or `cause`. Undici's `fetch failed` cause carries `host:port`.
- **Classification.** The response is 200 `{result, httpStatus, elapsedMs}`:
  - `ok`: 2xx whose JSON object has a `choices` array.
  - `unauthorized`: 401 or 403.
  - `not-found`: 404.
  - `rejected`: any other 4xx.
  - `server-error`: 5xx.
  - `bad-response`: 3xx, a non-JSON or `choices`-less 2xx, or an over-limit body.
  - `timeout`: the deadline passed, including after the headers arrived; `httpStatus` is then non-null.
  - `unreachable`: a DNS, connect, TLS or reset failure, including a reset mid-body after a status arrived.
  - `invalid-address` and `invalid-key`: as above, with no request sent.
  - `unconfigured`: as above.

  `httpStatus` is the status when one was received, otherwise null. `elapsedMs` is a non-negative integer.

  The route response schema lists 200, 400, 401, 403, 413, 415 and 500. `readSettings` can throw on corrupted stored settings, which gives a sanitized 500.

- **UI.** A 「测试连接」 button sits in the model form's action area and shares the page's pending fence.
  - Its label reads 「测试连接（已保存的默认模型）」.
  - Fixed Chinese texts:
    - ok → 「连接成功」 plus the elapsed time;
    - unconfigured → 「请先保存完整的模型配置」;
    - unauthorized → 「密钥无效或无权访问该模型」;
    - not-found → 「地址或模型不存在」;
    - rejected → 「模型服务拒绝了请求」 plus the HTTP status;
    - server-error → 「模型服务出错」 plus the HTTP status;
    - bad-response → 「地址返回的不是模型接口」;
    - timeout → 「连接超时」;
    - unreachable → 「无法连接到模型地址」;
    - invalid-address → 「模型地址格式无效，需以 http:// 或 https:// 开头」;
    - invalid-key → 「已保存的密钥包含无效字符」.
  - not-found and bad-response append 「OpenAI 兼容地址通常以 /v1 结尾」.
  - The result is shown in the page's existing single status/alert region: `role=status` for ok, `alert` otherwise. No second live region is added.
  - The address input gets the help text 「OpenAI 兼容地址，通常以 /v1 结尾」 through `aria-describedby`.
  - A new `'test'` phase must be listed in both `busy` and `visible` (`model-page.tsx:211-212`). While pending, the single status region (`#model-status`) shows 「正在测试连接…」.
  - Testing must not modify any form input: no `setKey('')`, and an unsaved typed value stays as it is. The test always uses saved values, and the button label says so.

## Governing invariant

The probe hits exactly the URL, credential and model that a newly started instance would use. Its result never discloses the key, the upstream body or the URL.

## Sibling surfaces

- Overlay generation (`managed-config/generate.ts`) owns the `hasCompleteModelSettings` predicate and the baseURL hand-off. Reuse the predicate through the shared settings mapping; do not fork it.
- `instance-actions.ts` owns the empty-body and error mapping, which becomes the shared module. `request-guard.ts` and `admin/routes.ts` own the transport and the first authority check.
- The browser copy of the completeness predicate (`platform/web/src/model-config.ts:81`), used for admin landing. It is unchanged; the probe does not depend on it.
- The `docs/DEPLOY.md` public-API table: add a row for the test endpoint.
- **Network path.** The probe leaves from the platform container on the Compose `default` network (`deploy/compose.yml:23-26`), not from an employee `/28` bridge. Node's built-in fetch ignores `HTTP(S)_PROXY`, and TLS trust comes from the platform image's CA bundle. So 「连接成功」 proves the address, key and model from the platform container. It does not prove employee-instance egress, and DEPLOY.md must say so.
- **Existing OpenAI-shaped test fixtures.** `platform/test/deployment-model-wire.ts` and `model-refusal-fixture.ts` should be reused, or extended, before a new loopback server is written.
- The logger redaction list in `app.ts`.
- The UI pending fence in `model-page.tsx`.

## Seams under test

- The HTTP route through `buildApp` against an owned loopback OpenAI-shaped server: integration.
- The probe function (URL building, request, classification), unit-tested and integration-tested against the loopback server with an injected short deadline. The route always passes the 20 s default constant, and a unit assertion checks that constant. No `buildApp` signature change.
- The built UI through Playwright against the real platform plus the owned loopback upstream: UI.

## Required evidence

- **Integration**, one case per result code:
  - URL rule, with and without a trailing `/`, and with a path prefix;
  - exact header and body;
  - a redirect is not followed (the redirect target is never hit);
  - a 64 KiB+1 body gives `bad-response`;
  - a hang hits the deadline: tested at the probe-function seam with a short injected deadline; the route's default is asserted to be 20 s;
  - a refused port gives `unreachable`;
  - a scheme-less address and a non-http scheme give `invalid-address`, and a CR/LF key gives `invalid-key`, each with zero upstream requests;
  - client disconnect and app close during a hanging upstream abort the upstream request promptly (the upstream observes the socket close), and close does not wait for the deadline;
  - an incomplete config makes zero upstream requests;
  - 401, 403 and wrong-body/415 rejections make zero upstream requests;
  - the key and the upstream body (with a unique marker) are absent from the response, the captured logs and the audit rows.
- **UI:**
  - save then test gives ok;
  - a wrong key gives 「密钥无效…」;
  - a wrong path gives 「地址或模型不存在」 plus the `/v1` hint;
  - the pending fence (one request despite a double click);
  - a revoked session gives 401 and returns to login, and a demotion gives 403;
  - zero unexpected console errors;
  - a screenshot.
- `pnpm contract:check` passes after `contract:write`.

## Non-goals

- Testing non-default models or unsaved form values.
- An audit event.
- Server-side serialization of concurrent probes.
- Header or streaming parity with DSH.
- `rejected` is not proof of misconfiguration. A provider may refuse `max_tokens: 1`, for example a reasoning model that needs `max_completion_tokens`. DEPLOY.md says so.
- Auto-correcting the address.
- Testing employee-instance egress.
- A model proxy (T12).
- Real-provider verification by the agent: that needs separate SHA-bound authorization. In acceptance the owner clicks the button.

## Review focus

- The URL rule matches DSH exactly.
- No secret or body leaks on any path, including errors and logs.
- Time and size bounds hold, and redirects are refused.
- The authority recheck and transport policy match existing admin mutations.
- The UI keeps a single live region and the shared pending fence.
