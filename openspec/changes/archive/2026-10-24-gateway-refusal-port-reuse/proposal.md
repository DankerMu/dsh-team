## Why

CI run 40049206587 (PR #328 head `45f1f3d`, no gateway change) failed in `platform/test/gateway-http.integration.test.ts` "reports connection refusal without trying another destination and recovers on a later resolution" with `expected 200 to be 502` (#330).

The test closes the `retired` upstream and only then binds the `healthy` upstream and the forwarding app. Either listener can receive the just-released ephemeral port. When that happens, the "refused" destination answers instead of refusing. The WebSocket `refused` case in `platform/test/gateway-websocket.integration.test.ts:763-800` has the same order: close, then `withForwardingApp` binds.

## What Changes

- In both refusal cases, every listener the test itself needs is bound **before** the refused upstream is closed. The close happens immediately before the refused request, inside the forwarding-app callback.
- The existing assertions are unchanged: HTTP 502 `Bad Gateway` body, then `healthy` after the resolver switches; WebSocket 502 without credential leakage. No assertion is added (the HTTP case does not count `healthy` requests today, and this change does not add that).
- No retries, sleeps, port reservation or production change.

## Triage

```text
Issue type: test
Fixture level: compact (concurrency pack selected, but the defect is only listener-bind order inside test scaffolding; no production shared state, entrypoint or format is touched)
Upstream suggested level: absent
Blast radius: two integration test cases; a wrong fix would hide a real gateway refusal regression or keep the flake
Selected risk packs: Concurrency / shared state / ordering
Evidence floor: pnpm test:integration on both gateway files (repeated), pnpm check:fast
```

`design.md` is omitted at the compact level.

## Impact

- `platform/test/gateway-http.integration.test.ts`
- `platform/test/gateway-websocket.integration.test.ts`
- No `platform/src/` change.
