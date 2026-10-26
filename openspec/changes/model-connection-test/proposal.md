## Why

#363. During stage-1 manual acceptance (#350) the administrator saved the model address `https://www.dmxapi.cn` without `/v1`. The configuration saved and the instance started, but the first employee message failed to reach the model.

DSH (pi-ai 0.87.1 / openai 6.40.0) uses the address verbatim as the OpenAI-compatible baseURL and requests `baseURL + '/chat/completions'`. It never adds `/v1`. Stage 1 deliberately made no model connection from the platform, so the administrator had no way to check a configuration before employees used it. The owner has decided to add one.

## What Changes

- **New endpoint.** `POST /_platform/api/admin/model-config/test` is administrator-only and takes an empty JSON body.
  - It reads the **saved** address, key and default model.
  - It builds the URL exactly as DSH does and sends one minimal non-streaming completion request (`max_tokens: 1`) with a 20 s deadline.
  - It returns `{ result, httpStatus, elapsedMs }`, where `result` is a closed-set code. It never echoes the upstream body, the URL or the key.
- **Model page.**
  - A 「测试连接」 button tests the saved default model.
  - Each result gets a fixed Chinese explanation, with a `/v1` hint for not-found and bad-response.
  - The address field gets a short help text.
- **Docs and spec.** The AGENTS.md model-configuration paragraph, `docs/DEPLOY.md` §acceptance note and the `admin-console` spec now say that the platform can make this one administrator-triggered connection.
- **Unchanged.** The model-config GET/PUT behaviour, overlay generation and instance-lifecycle behaviour.
- **Refactor.** A pure extraction of the settings→model-settings mapping out of `orchestrator/instance-service.ts`, a critical path that needs human line review.
- **Contract.** Two result codes beyond the nine in #363, `invalid-address` and `invalid-key`, both sent without any request. The PR states that this widens the issue's contract.

This change also carries the archive of `frosted-glass-platform-ui` (#361, merged in #362) in its own commit.

## Triage

```text
Issue type: feature
Fixture level: expanded (new public API route, auth/permissions, secret handling, first outbound network call from the platform process)
Upstream suggested level: absent (agree: expanded on public-API and secrets triggers)
Blast radius: administrator model page and one new admin route; secret (model key) exposure surface; platform outbound egress
Selected risk packs: Public API; Config; Auth / permissions / secrets; Concurrency; Error handling; Resource limits; Documentation
Evidence floor: integration tests against an owned loopback OpenAI-shaped server for every result code, URL rule, headers/body, no-redirect, size/time bounds and secret absence; pnpm test:ui real save→test flows; contract:write; pnpm check; exact-head VPS test:docker + test:deploy
```
