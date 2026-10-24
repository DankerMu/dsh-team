## 1. Evidence on the failure path

- [ ] 1.1 Add the held-preflight (never released; settles by the preflight's 10s abort) and failed-preflight (500) induced cases, each `it` timeout 30_000ms; assert the exact leading timeout text, the closed-set evidence, cleanup facts in the message JSON and secret-free strings; observe RED on the current file.
- [ ] 1.2 Implement the local evidence wait helper (same predicate, 5000ms/20ms bound, same order) at the initial ownership call site only; observe GREEN.
- [ ] 1.3 Compose scenario cleanup per step with independent `confirmed|failed` facts carried in the message JSON, first failure primary (same error object, message rewritten in place with the first line kept), cleanup-only failures as `Lifecycle cleanup failed` with step outcomes only (raw errors only in `cause`); verify the held-preflight case confirms main/Engine/root retirement. Document in the test that the published-then-cleared boundary is covered by evidence shape only.

## 2. Verification

- [ ] 2.1 `pnpm check:fast`; `pnpm test:integration platform/test/instance-lifecycle.integration.test.ts` three times; full `pnpm test:integration` once; record `scripts/dev-server.sh` SHA256 unchanged.
- [ ] 2.2 Review, CI, trusted exact-head Docker/deploy custody evidence, merge; post the diagnosis summary on #312 and keep the historical cause UNKNOWN.

## Risk mapping

- Selected: Error handling / partial outputs → 1.3; first failure preserved, independent cleanup facts.
- Selected: Concurrency / ordering → 1.1–1.2; same poll/bound/order, held preflight never released; command settles via its own 10s abort before Engine close.
- Selected: Auth / permissions / secrets → 1.1; evidence closed-set, fixture key/socket/env/log absent.
- Selected: Legacy compatibility → 1.2, 2.1; original scenario unchanged and repeated.
- Not selected: Public API / CLI / script entry — `pnpm dev:bg` and `scripts/dev-server.sh` are exercised but byte-identical (SHA256 recorded in 2.1).
- Not selected: Config / project setup — no configuration or environment field added.
- Not selected: File IO / path safety — the test only stats files in its own private root and writes nothing new.
- Not selected: Schema / field names — the evidence is a test-local error message, not a persisted or consumed format.
- Not selected: Resource limits — bounded fixed facts; no new processes beyond two induced starts.
- Not selected: Release / packaging — no dependency change.
- Not selected: Documentation — no command or rule change.
- Non-goal: inducing the published-then-cleared boundary (needs a script/production change); covered by evidence shape.
