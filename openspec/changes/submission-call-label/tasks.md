## Risk packs

- **Schema / field names — selected.** New `call` field in a strictly parsed evidence row. Tasks 1.1, 1.3.
- **Legacy compatibility — selected.** Rows without `call` stay valid; `browserExec` rows unchanged. Task 1.3.
- **Auth / permissions / secrets — selected.** The label must never carry arguments, names, IDs, paths, environment or credentials. Task 1.1 leak negatives.
- **Resource limits — selected.** Journal growth stays far below the 8 MiB bound; asserted by a size estimate in the PR, not a new limit. Task 1.4.
- **Error handling / partial outputs — selected.** Label derivation cannot throw past submission publication; failure maps to `other`/`unknown`. Task 1.2.
- **Documentation — selected.** AGENTS.md trusted Docker custody paragraph. Task 1.5.
- **Not selected:** public API, config, file IO/path safety (journal paths unchanged), concurrency (no new shared state; label is computed synchronously before the existing reservation).

## Must preserve

See `design.md`, "Must preserve".

## 1. Implementation (tests first)

- [ ] 1.1 Label derivation module with validator. Unit tests:
  - CLI: `['rm','-f',<id>]` → `{transport:'cli', operation:'rm'}`; `['network','connect',<net>,<ctr>]` → `network connect`; `['container','rm',...]` → `container rm`; `['compose','--project-directory','.', 'up']` → `compose`; unknown verb `['frobnicate']` → `other`; a resource-name-looking second token for a non-group verb never appears.
  - HTTP: `POST /containers/abc123/kill` → `POST /containers/{id}/kill`; `DELETE /networks/dsh-team-net-x` → `DELETE /networks/{id}`; `POST /networks/create` → itself; `POST /networks/net1/connect` → `POST /networks/{id}/connect`; `POST /containers/create?name=dsh-team-x` → `POST /containers/create` (query never kept); unknown shapes → `other`.
  - caller: a stack with a frame in `<repo>/platform/test/volumes-fixture.ts` → `volumes-fixture.ts`; no such frame → `unknown`; a frame path outside the repo with the same basename → `unknown`.
  - leak negatives: no label value contains `/` beyond the HTTP template, `dsh-team`, digits from IDs, `=`, or any argument after the verb/subcommand.
- [ ] 1.2 Producers pass the label: CLI wrapper, tracked HTTP client default submit and observer submit; derivation errors fall back to `other`/`unknown` and the submission is still published before dispatch. Integration: with a controlled transport that leaves the request unresolved, the journal `submitted` row has the exact `call` and the assessment stays `unconfirmed`.
- [ ] 1.3 Parser: accepts `{version,id,state:'submitted',call}` with a valid `call`, rows without `call`, unchanged `browserExec` rows; rejects `call` on `settled`/`client-closed-unknown`, `call` together with `browserExec`, extra/missing `call` keys, values outside the closed sets. Fresh-process assessment over a mixed old/new journal is unchanged in verdict.
- [ ] 1.4 Audit: list tests that catch a mutating CLI non-zero exit (without `acceptedStatus`) or a non-qualified HTTP error without rethrow; report in the PR body with file:line. Change none unless unambiguously wrong (then with its own test).
- [ ] 1.5 Docs: one sentence in AGENTS.md "Trusted Docker verification" custody paragraph about the closed-set `call` label; bundled runtimes include the new module (check build/bundle scripts and their tests).

## 2. Verification

- [ ] 2.1 `pnpm check`
- [ ] 2.2 Exact-head VPS `pnpm test:docker` with confirmed cleanup; spot-check that `submitted` rows carry `call` with plausible callers; `pnpm test:deploy`; CI green.

## Non-goals

See `design.md`.
