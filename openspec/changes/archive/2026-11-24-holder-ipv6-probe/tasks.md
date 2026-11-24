## 1. Implementation

- [x] 1.1 `holderIpv6Reach` in `document-server-net-fixture.ts` (design § Must add/change), reusing `reach`. Resources are registered before creation, and cleanup runs in `finally` with `AggregateError` on a double failure.
- [x] 1.2 Integration cases with a stand-in command: the positive case, and the rejection cases and mutants (a)–(k), including (d2) of design § Required evidence. Each mutant red with its case, then green; record each run for the PR.
- [x] 1.3 `deployment.docker.test.ts`: call the step after `holderRestartSequence`, timeout `900_000 + 1_380_000 + 600_000`, with the twenty calls itemised in the budget comment (design § Budget). The PR states runner fit.
- [x] 1.4 Docs:
  - `docs/DEPLOY.md:283`: the IPv6 sentence;
  - `deploy/README.md:13` and `:43`.
- [x] 1.5 PR:
  - `Closes #654`;
  - apply `diff-limit-exempt` before pushing the frozen head, if the diff exceeds 400 lines.

## 2. Verification

- [x] 2.1 `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [x] 2.2 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`. The step must pass, with its returned reach and DROP counts in the evidence, and cleanup must be confirmed with the host fence passing. This run also measures the design's § Unmeasured assumptions.
