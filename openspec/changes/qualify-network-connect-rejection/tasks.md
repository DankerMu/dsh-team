## Risk packs

- **Verification evidence (settlement classification), selected.** `isDefinitiveRejection` in `scripts/verification-submissions.mjs:105` gains a single clause: `method === 'POST'`, endpoint matching `^/networks/[a-zA-Z0-9][a-zA-Z0-9_.-]*/connect$` (the same target grammar as the existing entries), and `statusCode === 400`. Settlement still requires a canonical `DockerHttpError` at the header boundary, and the same error is still rethrown. No earlier unresolved request is completed by it.
- **Not selected:** schema, auth/secrets, file IO, resource limits, public API, release, legacy compatibility. Existing entries and their tests are unchanged.

Governing invariant: a submission settles without a successful response only for a closed set of method, endpoint-template and status triples, each a definitive Docker reply, with independent resource-state checks as the backstop. The set grows by exactly `POST /networks/<target>/connect` 400.

## 1. Implementation

- [ ] 1.1 Add the clause to `isDefinitiveRejection`. Add matrix cases to `platform/test/docker-client.integration.test.ts`, following the existing table:
  - settles `POST /networks/<id>/connect` 400, rethrowing the original error;
  - keeps connect 403, 404, 409 and 500 unresolved;
  - keeps `POST /networks/<id>/disconnect` 400 unresolved;
  - keeps a noncanonical error with `statusCode: 400` on connect unresolved, extending the existing `canonical: false` case (`:167-175`);
  - keeps connect 400 on a non-matching target, such as `/networks/../connect` and `/networks/owned/extra/connect` (`operation: 'other'`), unresolved, as the stop and delete rows already do (`:176-191`, `:209-216`).

  Row labels: `POST /networks/{id}/connect` and `POST /networks/{id}/disconnect`. Both are already in the storage vocabulary (`scripts/verification-submission-storage.mjs:313-314`), so the vocabulary needs no change.

  Red before green for the settle case.

- [ ] 1.2 No other consumer enumerates the matrix: `scripts/README.md`, `scripts/test-guardrails.sh` and `platform/test/README.md` were checked by grep, so none of them changes.

## 2. Verification

- [ ] 2.1 `pnpm check`.
- [ ] 2.2 VPS exact-head `pnpm test:docker` + `pnpm test:deploy`, cleanup confirmed; local exact-head `pnpm test:stack`.
- [ ] 2.3 After merge, rebase #548: its exact-head `pnpm test:docker` cleanup is `confirmed`.
