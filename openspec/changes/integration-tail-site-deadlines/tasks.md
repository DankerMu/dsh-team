## Risk packs

- **Concurrency / ordering — selected.** Each bound and deadline is derived from when its step actually starts, and from measured maxima under load. Tasks 1.1–1.4, 2.1.
- **Error handling — selected.** Every stall fails with a message naming its phase, below the case budget. Task 1.4 has the red probes.
- **Not selected:** product code, config, file IO, schema, auth, legacy, release, docs. All of this is test-only.

## Acceptance mapping (#719, rows #3–#6)

- **Red probe per site:** a stalled step names its phase, not `Test timed out` (task 1.4).
- **5 loaded full runs** at load ≥ 13 and < 67 (task 2.1). This slice runs them on its own head. Slice 2 runs them again.
- **Row #6:** recorded, no change (proposal).

## Must preserve

- The case titles, assertions and budgets of the three cases. That is `CASE_MS` 22 s in ragflow-proxy-auth, `OWNERSHIP_CASE_MS` 160 s and `RECEIPT_CASE_MS` 20 s, plus the chrome-start offsets and attribution regexes.
- `boundedStep` and `registerInstanceUser` keep their signatures.

## 1. Implementation

- [x] 1.1 #3: implement the ragflow close-abort bounds as described in proposal § What Changes. Before writing a new helper, grep for an existing signal-race helper.
- [x] 1.2 #4: wrap registration and start from outside, using named, measured per-step constants, and update the ledger. Do not change `OWNERSHIP_CASE_MS`.
- [x] 1.3 #5: store the offset in `receiptWriteFault` and compute the deadline from `failAcknowledgedReceipt`'s `since`.
- [x] 1.4 Red probes. Each probe is a temporary edit that is reverted afterwards; record its command and message in the PR.
  - (a1) Await `received(2)` instead of `received(1)`. Expect `close-abort: upstream received: TimeoutError…` below 22 s.
  - (a2) Skip `app.close()`. The proxy's own `RAGFLOW_TIMEOUT_MS` (10 s, `platform/src/ragflow-proxy/client.ts`) then answers the read, so `pending` resolves instead of stalling. Expect the named elapsed-constant assertion to fail at about 10 s, never the runner's timeout.
  - (a4) Hold `app.close()` with a temporary `onClose` hook registered before `app.listen` in `withProxy`. The hook resolves after a fixed delay that ends after the `close-abort: application close` bound and before 22 s, so `withApp`'s teardown `app.close()` still finishes. Expect `close-abort: application close: …` below 22 s.
  - (a3) Await `socketClosed(2)`. Expect `close-abort: upstream socket closed: …` below 22 s.
  - (b) Hold a Docker engine call that the start route waits on, using `startupUnixServer`'s second callback. Expect `instance start: …` below 160 s.
  - (c) Point registration at a socket that accepts but never answers. Expect `user registration: …`.
  - (d) Insert a delay of more than 1.5 s inside `startChrome`, before the pid receipt write, for example in the pass-through registration write of the `writeFile` mock. The 1500 row is red before 1.3 and green after.

## 2. Verification

- [x] 2.1 Measure the three cases under load, following #713:
  - Temporarily raise the ragflow and chrome-start budgets to 60 s. Leave `OWNERSHIP_CASE_MS` alone, because it is already 160 s.
  - Hold the 1-minute load at ≥ 67 with `yes` generators.
  - Run the three files 5 times, recording each step's maximum as a per-phase `performance.now()` delta in a temporary log line.
  - Revert all temporary edits, then pick the named constants from those maxima.

  Then run full `pnpm test:integration` 5 times. Each run starts at a 1-minute load ≥ 13 and < 67, with 12 bounded `yes` generators that are confirmed gone afterwards. Also run `pnpm lint`, `pnpm typecheck` and `pnpm fmt:check`.

- [ ] 2.2 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`. The PR body says `Refs #719`.
