## Risk packs

- **Concurrency / shared state / ordering — selected.** The event loop must stay free; settlement happens exactly once; the timer must be cleared. Tasks 1.1, 1.2.
- **Error handling / rollback / partial outputs — selected.** Timeout, kill, oversized output, spawn error, `gone` vs unavailable. Tasks 1.1, 1.3.
- **Auth / permissions / secrets — selected.** Process-identity authority must never claim absence when uncertain. Task 1.3.
- **Not selected:** config, release, docs beyond the PR statement.

## Acceptance-criteria mapping (#659)

- **AC1** (no `spawnSync` on Darwin; timeout, SIGKILL, parsing and errors preserved) → 1.1, 1.2 (the mock's `spawnSync` branch for the observer throws after the fix).
- **AC2** (a hung observation leaves a 50 ms timer on time; rejects after the bound; red before, green after) → 1.2.
- **AC3** (`gone` and unparseable branches locked) → 1.3.
- **AC4** (all callers' cases pass; custody, retirement and cancellation on macOS) → 1.4, 2.1.
- **AC5** (`tasks.md:6775` consistent) → 2.2. The bound is back to 2 s, so the PR says so and the archive is unchanged.
- **AC6** (nothing lengthened, retried or removed) → must preserve.

## Must preserve

See design.md § Must preserve.

## 1. Implementation

- [x] 1.1 Make `darwinObservation` asynchronous, per design.md § Must add/change:
  - stdio `['ignore','pipe','ignore']`;
  - a byte cap above 4096 that kills the child;
  - a 2000 ms SIGKILL timer that takes precedence;
  - exactly one settlement on `close`, with the timer cleared on every path;
  - a fresh `Error` with no `code` on spawn throw or `error`;
  - no production seam.
- [x] 1.2 Add the hung-observation case, using the real stand-in through the mock. Assert:
  - the 50 ms timer fires before the observation settles;
  - the rejection is unavailable and comes no earlier than the bound;
  - the captured child shows `signalCode === 'SIGKILL'`, then ESRCH.

  Red before the fix: route `spawnSync` to the hung stand-in through `actual.spawnSync`. Green after: the `spawnSync` branch for the observer throws.

- [x] 1.3 Move the existing native cases from the `spawnSync` mock to a `spawn` mock, keeping their assertions:
  - zombie;
  - gone;
  - missing interpreter;
  - denied query;
  - unknown state;
  - invalid microseconds.

  Use real stand-ins as given in design.md § Seams. Add:
  - an oversized-output case: the rejection comes before a 1000 ms timer, SIGKILL is recorded, and it is a characterization of the cap;
  - a missing-interpreter case: no `code`, and `liveProcessBirth` rejects instead of returning `null`.

- [x] 1.4 `browser-exec.integration.test.ts`: its `spawn` mock passes `/usr/bin/python3`, and only that, through to the real `spawn`. No assertion changes.

## 2. Verification

- [ ] 2.1 Locally on macOS, three times in a row: `browser-native`, `browser-exec`, `trusted-docker-custody`, `trusted-docker-retirement` and `trusted-docker-cancellation` integration. Then `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [ ] 2.2 State in the PR that the archived 2 s argument holds again; the archive stays unchanged.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
