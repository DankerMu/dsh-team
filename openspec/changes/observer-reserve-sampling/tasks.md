## Risk packs

- **Concurrency / shared state / ordering — selected.** The fix replaces an unsynchronised two-sample oracle with a deterministic quiescent point; the new wait must not deadlock and adds no deadline. Tasks 1.1, 1.2. Residual (out of scope): DELETE's own 2000 ms abort can still expire before `bound` under extreme load and fail `:492` — the separately tracked wall-clock class.
- **Not selected:** all product surfaces (no product code changes), config, auth/secrets, file IO (markers only read), release, documentation.

## Acceptance-criteria mapping

- AC1 (both requests received before the first sample; first sample = participant + POST + DELETE) → task 1.1.
- AC2 (deterministic proof: DELETE written during the rejected reserve; red before, green after) → task 1.2.
- AC3 (failure message names added/missing ids and `observer`) → task 1.1.
- AC4 (no 200 ms / deadline change, no sleep/retry/skip; `:498`, `:517-535`, `:555-562` unchanged; stalls=false passes) → must preserve.
- AC5 (5 full `pnpm check` under load ≥ 13, load and result each) → evidence 2.1.

## Must preserve

- The 200 ms abort, `startObserverChild` `timeout: 5000`, every wall-clock deadline; no added sleep, retry or skip.
- Assertions `:479-489` (manifest unchanged, then the `current.json` rewrite), `:492`, `:498`, `:517-535`, `:555-562`; the stalls=false variant's flow.
- Product scripts under `scripts/verification-*.mjs` untouched.

## 1. Implementation

- [ ] 1.1 Extract the stalls=true `beforeRelease` oracle into one test-local helper (`quiescent()`, then two `sample()`s around the rejected reserve). `quiescent()` awaits a stub-server resolver that fires on the second request (`DELETE /networks/owned-effect`), raced against the child's exit through the fixture's existing `observed.closed` pattern (exit → immediate failure with the request list and stderr; no new deadline). Then assert the request list is exactly POST + DELETE and the first sample is exactly: the participant file (name equal to `first.participant`) plus the POST and DELETE markers identified by the per-request marker ids the server handler already computes (`${first.generation}.${id}`, content `observer === first.generation`). On mismatch at the second sample, report each added or missing marker id with its `observer`.
- [ ] 1.2 Separate deterministic regression case using the same helper: the child first issues a GET held by the stub server (observations write no marker), and the helper's first observable action opens it. It passes with 1.1's order; record in the PR a red run with the old order (`sample()` before `quiescent()`), which must fail on the second sample (3 vs 2). The old oracle is not committed. The regression case asserts its own request list (GET + POST + DELETE) and does not change `:517`/`:554`.

## 2. Verification

- [ ] 2.1 The file repeated (≥ 10 runs); 5 full `pnpm check` runs with 1-minute load ≥ 13 (generate parallel load if needed), recording load and result for each; `pnpm check`.
- [ ] 2.2 CI; exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, confirmed cleanup.
