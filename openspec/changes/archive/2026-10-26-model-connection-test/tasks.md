## Risk packs

- **Public API / CLI / script entry — selected.** There is a new route, its schema and the regenerated OpenAPI contract. Tasks 1.2 and 3.2.
- **Auth / permissions / secrets — selected.** The route is admin-only, rechecks authority, and must never let the key leave the request header. Tasks 1.2 and 2.1.
- **Error handling / rollback / partial outputs — selected.** The closed-set classification covers every network and HTTP failure. Task 1.1.
- **Resource limits / large input / discovery — selected.** A 20 s deadline, a 64 KiB body cap and no redirects. Task 1.1.
- **Documentation / migration notes — selected.** AGENTS.md, DEPLOY.md and the spec change the "platform never connects to the model" statement. Task 2.3.
- **Config / project setup — selected.** No new environment input. The probe's network path is the platform container on the Compose `default` network, with no proxy and Node's built-in CA store (not the image system certificates), as in the DSH instance. That differs from employee egress and is documented in DEPLOY.md. Task 2.3.
- **Concurrency / shared state / ordering — selected.** An in-flight outbound request must be aborted on client disconnect and on app close; concurrent probes are not serialized (non-goal). Tasks 1.2 and 1.3.
- **Not selected:**
  - File IO, Schema/DB: no persisted state.
  - Legacy compatibility: GET/PUT unchanged, enforced by the existing tests.
  - Release: no new dependency; Node's built-in fetch is used.

## Must preserve

See `design.md`, "Must preserve".

## 1. Backend

- [x] 1.1 Extract the shared pieces, keeping behaviour identical (existing tests stay green):
  - the empty-body validator and error mapping, out of `instance-actions.ts`;
  - the settings→model-settings mapping and the `DSH_TEAM_MODEL_API_KEY` constant, out of `instance-service.ts` into `managed-config`.
- [x] 1.2 Write the probe module: URL building as in design.md, the http(s)-only rule, `invalid-address` and `invalid-key` with zero requests, the outbound request, the deadline as a parameter (default 20 s), the 64 KiB cap, no redirects, an external abort signal, and classification into every result code. Unit tests cover each.
- [x] 1.3 Add the route plugin `POST /_platform/api/admin/model-config/test`, registered by `adminRoutes`:
  - an empty `{}` body, using the shared validator;
  - an authority recheck after the body is read;
  - it reads the saved settings through the shared mapping and returns `unconfigured` without a request;
  - an `AbortController` owned by the route, aborted on client close and on app close;
  - fixed-message logging;
  - a response schema covering 200/400/401/403/413/415/500, then `pnpm contract:write`.
- [x] 1.4 Add integration tests with an owned loopback OpenAI-shaped server, covering every item under Required evidence: Integration.

## 2. UI and docs

- [x] 2.1 Model page:
  - the 「测试默认模型连接」 button with its saved-config note, sharing the pending fence;
  - the fixed result texts and the `/v1` hint, in the existing single live region;
  - the address help text through `aria-describedby`;
  - 401 goes to login and 403 to the no-permission state;
  - unit tests in `model-page.test.tsx`.
- [x] 2.2 UI tests in the existing admin-models UI suite (or a sibling), against an owned loopback upstream: ok, wrong key, wrong path plus hint, double-click fence, 401, 403, zero console errors, and the screenshot `admin-models-connection-test`.
- [x] 2.3 Update the docs:
  - the AGENTS.md model-config paragraph: GET/PUT still never connect, and only the explicit test route connects;
  - the `docs/DEPLOY.md:133` note, saying that success proves the address, key and model from the platform container, not employee egress, and that `rejected` may be a provider parameter refusal;
  - a row for the endpoint in the DEPLOY public-API table.

## 3. Verification

- [x] 3.1 `pnpm check`
- [x] 3.2 `pnpm test:ui`, plus `pnpm contract:check`.
- [x] 3.3 Exact-head VPS `pnpm test:docker` + `pnpm test:deploy`; CI green.

## Non-goals

See `design.md`, "Non-goals".
