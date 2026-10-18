## 1. Fixture and regression

- [x] 1.1 Admit the expanded fixture and pass strict OpenSpec validation. Parent performs the mapped fixture review inline because the governing delegation policy prohibits a lone mapped review; independent multi-seat code review remains required.
- [x] 1.2 Reproduce the issue through real InstanceService and authenticated HTTP: A/B running, limit2→1, exact A404, POST200/full followed by the incorrect GET500. Retain semantic RED before production edits.

## 2. Separate absence from failure

- [x] 2.1 Separate identity-fenced verified absence from exceptional receipts in the existing service; preserve current settings/capacity, flight ownership, readiness, error precedence and stop/shutdown behavior. Parent implements this single mapped slice inline under the governing delegation policy.
- [x] 2.2 Prove ordinary full HTTP/WS responses, HTML waiting redirect, zero old-upstream hits, unchanged B, live model/capacity observations and successful new-identity retry. Preserve failed-image, generic-inspect and changed-identity controls.
- [x] 2.3 Add the real Docker two-instance capacity-refusal/recovery scenario using exact invocation ownership and existing public lifecycle helpers; no provider requests or unrelated resource mutation.

## 3. Verification and release

- [x] 3.1 Run focused unit/integration regression, type/lint/contract checks and build; update existing lifecycle documentation after runtime proof. Preserve exact commands, exits and evidence limitations.
- [ ] 3.2 Complete four-seat independent high-risk review with the bounded fix gate; record critical orchestrator paths and exact SHA for the user-authorized Epic-end human line review, not a passed review.
- [ ] 3.3 Run exact-head trusted target, standalone Compose and original full Docker discovery with independent owned-resource cleanup and unchanged host fences; publish owner evidence and require green CI.
- [ ] 3.4 Merge through protected PR and archive the change with validated synchronized specs and required fresh archive acceptance.

## Risk packs

- Selected — Public API / CLI / script entry: public start/status and HTTP/WS gateway regression, tasks1.2/2.2.
- Not selected — Config / project setup: no new inputs or deployment changes; existing settings are observed.
- Not selected — File IO / path safety / overwrite: no new persistence or path mutation; Docker fixture cleanup uses existing ownership rules.
- Not selected — Schema / columns / units / field names: no schema, migration or response shape changes; contract check in3.1.
- Selected — Auth / permissions / secrets: real authenticated routes and obsolete credential non-reuse; tasks2.2/2.3.
- Selected — Concurrency / shared state / ordering: flight settlement, retry and identity supersession; tasks2.1/2.2 and existing regressions.
- Selected — Resource limits / large input / discovery: lowered capacity without sibling eviction; tasks1.2/2.3, no capacity-policy change.
- Not selected — Legacy compatibility / examples: clean in-place implementation, no compatibility shim or new example.
- Selected — Error handling / rollback / partial outputs: true exceptions remain500/502 and durable errors remain ordinary; task2.2. Rollback is reviewed revert, no persisted migration.
- Not selected — Release / packaging / dependency compatibility: no dependency/image/package change; existing full Docker/Compose gates remain required.
- Selected — Documentation / migration notes: update existing lifecycle contract and archive delta, tasks3.1/3.4.

## Evidence to date

- Semantic RED on base `5ed9374a5b679d00c480a054cce247a17c75ea44`: authenticated POST200/full passed; subsequent GET returned500 instead of200. The focused diagnostic selected one case, not a full acceptance run.
- After separation: `pnpm test:integration platform/test/instance.integration.test.ts platform/test/instance-lifecycle.integration.test.ts` passed11/11, including real HTTP/WS responses and zero additional hits at the obsolete upstream across full/unconfigured/stopped observations.
- `pnpm check:fast`, `pnpm build`, `pnpm contract:check` and the initial full unit run2216/2216 passed. Added catch-time absence preservation and final Docker evidence are tracked separately; no final acceptance claimed here.
- Four independent technical seats reviewed `50c12d4eaa51223bfa6b4a4dceaed8527ac6f86a` without actionable findings. Trusted target execution then exposed a fixture baseline race, not a service failure: all row fields were preserved except B's legitimate `last_activity_at` after the fixture's own pre-baseline gateway request.
- The names-only diagnostic isolated that field without printing row values. Gateway usability checks now follow exact unchanged-row assertions; no field is omitted and no timer, sleep, database rewrite or production behavior was changed. The same real Docker scenario then passed with new ready identity, new credential, preserved volumes and fresh endpoint binding. Both failing and passing runs left all owned inventories empty and the daemon, bridge and original four workloads unchanged.
- That focused diagnostic pass selected1/4 cases and is not final-head acceptance. Final target4, full Docker, standalone Compose and required CI remain pending after repair review. The final local unit run passed2217/2217.
