## Risk packs

- **Schema / field names — selected.** New `call` field in a strictly parsed evidence row. Tasks 1.1, 1.3.
- **Legacy compatibility — selected.** Rows without `call` stay valid; `browserExec` rows unchanged. Task 1.3.
- **Auth / permissions / secrets — selected.** The label must never carry arguments, names, IDs, paths, environment or credentials. Task 1.1 leak negatives.
- **Resource limits — selected.** Journal growth stays far below the 8 MiB bound: about 2365 labelled rows × ≤ 120 bytes ≈ 0.3 MB on top of today's 0.36 MB; task 1.3 adds a parser test at the existing bound with labelled rows, and task 2.2 records the real journal size.
- **Error handling / partial outputs — selected.** Label derivation cannot throw past submission publication; failure maps to `other`/`unknown`. Task 1.2.
- **Moved out:** finding and making explicit the tests that tolerate failed mutations (#373 step 2) is #374.
- **Documentation — selected.** AGENTS.md trusted Docker custody paragraph. Task 1.4.
- **Not selected:** public API, config, file IO/path safety (journal paths unchanged), concurrency (no new shared state; label is computed synchronously before the existing reservation).

## Must preserve

See `design.md`, "Must preserve".

## 1. Implementation (tests first)

- [ ] 1.1 Label derivation and validator in `scripts/verification-submission-storage.mjs`. Unit tests:
  - CLI: `['rm','-f','dsh-team-x']` → `{transport:'cli',operation:'rm'}`; `['network','connect','n','c']` → `network connect`; `['container','rm','x']` → `container rm`; `['compose','--project-directory','.','up']` → `compose`; `['network','dsh-team-net']` → `network`; `['frobnicate']` → `other`; `[]` → `other`.
  - HTTP (finite whitelist shared with the parser; `{id}` segments use the same character class as `isDefinitiveRejection`): `POST /containers/abc123/kill` → `POST /containers/{id}/kill`; `POST /containers/create?name=dsh-team-x` → `POST /containers/create`; `DELETE /networks/n1` → `DELETE /networks/{id}`; `POST /networks/n1/connect` → `POST /networks/{id}/connect`; `POST /networks/create`; `POST /volumes/create`; `DELETE /volumes/v1`; `POST /create?name=a%20b` → `other`; `POST /containers/a/b/c` → `other`.
  - caller from stack text: a `file:///…/platform/test/foo.docker.test.ts:1:2` frame after a `docker-command.ts` frame → `foo.docker.test.ts`; only `container-start-docker-fixture.ts` → that; only `docker-command.ts` → `unknown`; a same-named file outside the repository → `unknown`; plain-path and `file://` frames both work; `Error.stackTraceLimit` is restored.
  - leak negatives: no label contains `dsh-team`, an ID, `=`, `%`, `?`, `@`, a path separator outside the HTTP template, or any CLI argument after the verb/subcommand.
- [ ] 1.2 Producers: `beginVerificationSubmission(call)` writes `{ call }` as the `submitted` row detail; the CLI wrapper and the tracked client's default submit pass labels; the tracked client captures a construction-point caller; label derivation can never throw past publication (fallback `other`/`unknown`, submission still published before dispatch); no-argument calls omit `call`; observer submit unchanged. Integration, exact rows, fresh-process assessment `{"state":"unconfirmed"}`:
  - CLI: `runDockerCommand({file:'docker',args:['rm','-f','x']}, () => ({status:1}))` with no `acceptedStatus` → `{version:1,id,state:'submitted',call:{transport:'cli',operation:'rm',caller:'<this test file>'}}`, no settled row;
  - HTTP: reuse `docker-client.integration.test.ts` submission scenarios with a 409 (and a 500) on `POST /containers/<id>/kill` → `call:{transport:'http',operation:'POST /containers/{id}/kill',caller:'docker-client.integration.test.ts'}`;
  - async chain: test → helper → `await` → tracked client → caller is the test file; through a promise queue → construction-point caller.
- [ ] 1.3 Parser: accepts valid `call` rows, rows without `call`, unchanged `browserExec` rows; rejects `call` on `settled`/`client-closed-unknown`, `call` together with `browserExec`, missing/extra `call` keys, unknown transport, operation outside the whitelist/enum, caller not matching the pattern. A mixed old/new journal assesses exactly as before; a labelled journal near the 8 MiB bound still parses.
- [ ] 1.4 Docs: one sentence in AGENTS.md "Trusted Docker verification" custody paragraph about the closed-set `call` label and what is not labelled.

## 2. Verification

- [ ] 2.1 `pnpm check`
- [ ] 2.2 Exact-head VPS `pnpm test:docker` with confirmed cleanup; report the share of labelled `submitted` rows with a known caller and the journal size; `pnpm test:deploy`; CI green.

## Non-goals

See `design.md`.
