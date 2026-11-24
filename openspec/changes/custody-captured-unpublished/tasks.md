## 1. Implementation

- [ ] 1.1 `UNPUBLISHED_COMMAND_PRELOAD`'s 30 s block becomes synchronous sliced polling for a named `.run/` release file, still capped at 30 s.
- [ ] 1.2 Cases (a) and (b), each with a named budget and ledger. Run them red against the unchanged `captureStart` and record the outputs.
- [ ] 1.3 `captureStart`: drop the early `issued.set`, and set once after the wait; update the cleanup comment at `:770-771`; no growth past `max-lines`.
- [ ] 1.4 Mutant: the early `issued.set` restored → (a) and (b) red. Record it, then revert.

## 2. Verification

- [ ] 2.1 The trusted-docker fixture, custody, retirement and uncaptured integration files green; `pnpm lint`, `pnpm typecheck`, `pnpm check`.
- [ ] 2.2 PR with `Closes #692`.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, with confirmed cleanup.
