## 1. Implementation

- [x] 1.1 Cases (a)–(g) in `trusted-docker-fixture.integration.test.ts`, with `fixtureProcessCustody` exported and the spy rules of the proposal. Run (a) and (b) red against the unchanged `settle` and record them.
- [x] 1.2 `settle` and `stalled`:
  - the group kill treats EPERM as retiring and seeds `denied`;
  - the group probe treats EPERM as present;
  - `stalled` gains an optional `cause`, and the expiry passes the last EPERM;
  - the comment at `:473-474` says this.
- [x] 1.3 Custody `:709` and uncaptured `:67`: await `groupSettlesAfterClose(pids.command)`, with the imports updated. In uncaptured, move `:67-69` after `:70-73`.
- [x] 1.4 Mutants, each red with its case, then reverted:
  - EPERM tolerated for the single-process kill → (d);
  - every code tolerated by the probe → (e);
  - every code tolerated by the group kill → (f);
  - `cause` dropped → (c);
  - the kill's EPERM not seeded into `denied` → (g).

## 2. Verification

- [x] 2.1 The trusted-docker fixture, custody, retirement and uncaptured-fixture integration files green; `pnpm lint`, `pnpm typecheck`, `pnpm check`.
- [x] 2.2 PR with `Closes #690`.
- [x] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`, with confirmed cleanup.
