## 1. Refusal ordering

- [x] 1.1 In `platform/test/gateway-http.integration.test.ts` refusal case, bind `healthy` and the forwarding app first, then close the `retired` server (await `close`) inside the forwarding callback immediately before the refused request. Keep every existing assertion and the recovery step; add none. `withUpstream` cleanup already checks `server.listening` (`gateway-http-fixture.ts:103`), so an early close is safe.
- [x] 1.2 Apply the same order to the `refused` mode of the WebSocket upgrade-destination case in `platform/test/gateway-websocket.integration.test.ts`: close inside the `withForwardingApp` callback before `rejectedUpgrade`. The `missing`, `resolver` and `endpoint` modes are unchanged.
- [x] 1.3 Run `pnpm test:integration platform/test/gateway-http.integration.test.ts platform/test/gateway-websocket.integration.test.ts` three times. Expected: each exit 0, with the HTTP refusal case and all four WebSocket upgrade-destination modes (including `refused`) passing. Run `pnpm check:fast`, expected exit 0.

## 2. Delivery

- [x] 2.1 Review, CI, trusted exact-head Docker/deploy evidence, merge.

## RED evidence

The race cannot be reproduced deterministically, so there is no local pre-fix RED. The only failure evidence is CI run 40049206587 (`expected 200 to be 502`). The repeated runs in 1.3 are supporting evidence only: they cannot tell "fixed" apart from "did not flake this time". The fix is justified by the ordering argument, which reviewers check against the code: after reordering, no listener created by the test itself is bound after the close.

## Risk packs

- Concurrency / shared state / ordering — **selected**. The defect is listener-bind order against a released port, covered by 1.1 and 1.2.
- **Residual, not closed:** `vitest.config.ts` sets `fileParallelism: false` only for the `docker` and `model` projects. Integration files therefore run in parallel workers, and those workers continuously `listen(0, '127.0.0.1')` through `withUpstream`, `app.listen({ port: 0 })` and `unusedPort`. Any of them can still take the released port between the close and the single refused request. The reorder removes the in-case reuse (the inferred cause in #330) and shrinks the cross-worker window to one request; it does not close that window.
- **Alternatives rejected:**
  - A deterministic refusal target without a released port is not available portably through Node `net`, which has no bind-without-listen.
  - A listening socket that resets immediately produces `ECONNRESET`, not refusal. It would exercise a different gateway error path and change the test's meaning.
  - Retries, sleeps and port reservation are excluded.
- Not selected, because this is test-only reordering with no production or format change: Public API / CLI; Config; File IO; Schema; Auth; Resource limits; Legacy; Error handling; Release; Documentation.

## Sibling surfaces checked

- `platform/test/gateway-*.ts` and `platform/src/gateway/*.test.ts` contain exactly two "close then reuse the released URL" sites, at pre-change positions `gateway-http.integration.test.ts:254-256` and `gateway-websocket.integration.test.ts:772-774` on `main` `9a6a5ef`.
- Every other `close()`/`destroy()` is end-of-case cleanup or socket cancellation. This includes the `gateway-routing.integration.test.ts:178-235` observer, which closes only at the end.
- `unusedPort()` callers (`deployment-fixture.ts:103`, `deployment-tls-fixture.ts:81`, `main-startup-fixture.ts:115`) pick a port to bind later. Reuse there would surface as a bind collision, not a misrouted assertion. That is a different failure class, reported but not changed.
