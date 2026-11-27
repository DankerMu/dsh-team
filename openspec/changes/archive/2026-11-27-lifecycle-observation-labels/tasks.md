## Risk packs

- **Resource limits (selected):** aggregate observations under load, checked against the default and the case ledger (tasks 1.2 and 2.2).
- **Error handling (selected):** every stall names its site (task 1.1).
- **Not selected:** concurrency, file IO, public API, config, secrets, release, docs, legacy compatibility. The change touches only one test file's labels and constants.

## Must preserve

- Every assertion and explicit timeout in the file.
- `OWNERSHIP_CASE_MS = 160_000`, which is never raised.
- `HTTP_OBSERVATION_MS`, `HTTP_SEND_MS`, `gateway-http-fixture.ts`, `scripts/dev-server.sh` and every other file.
- No measurement instrumentation is committed.

## 1. Implementation

- [x] 1.1 Give every `observeHttp` call in the file a unique phase label.
  - **Probe method.** Before the change, swap only the observed promise for `new Promise(() => {})` at one scenario site (`:551`) and one `runDevLifecycle` site (`:277`). Leave the real command running. Record the unlabelled message.
  - **After the change.** Repeat the probe for each labelled site in the case and in `runDevLifecycle`.
    - Scenario-phase sites must report `…did not settle: <label>` in the message.
    - The cleanup sites `:338` and `:345` must report it in `cause`, with that step marked `failed`.
  - **Cleanup-site caveats.**
    - `:345` is reached only when the main is still alive at cleanup. The canonical pass path stops the main first (`:567-569`), so the probe for `:345` also temporarily drops the `finalStop` lines. A failing scenario would not work, because it discards the cleanup error (`:367-373`). The real `dev:stop` still spawns.
    - At `:338` and `:345`, the private root is retained by design. Remove it by hand afterwards and record the removal.
  - The probes are temporary and not committed.
- [x] 1.2 Run the measurement and apply the fit rule and ledger rule exactly as the proposal states them.
  - **Measurement.** Use a 60 s wide bound. Time each observation and the setup with `performance.now()`, buffer the samples, and append them once after the case. Count at least 5 in-band runs. Report `:345` as not reached on the pass path, not as a measured value.
  - **Result.** Write a basis comment for `:538` and `:551`, and update the ledger comment.
  - **Ledger stop.** If the inequality fails, ship labels only and report acceptance item 2 as open.
  - **Before commit.** Remove the instrumentation.

## 2. Verification

- [x] 2.1 `pnpm exec vitest run --project integration platform/test/instance-lifecycle.integration.test.ts`, `pnpm lint` and `pnpm typecheck` exit 0.
- [x] 2.2 Run 5 consecutive full `pnpm test:integration` runs, each starting at load ≥ 13 and < 67 with 12 bounded `yes` generators. All pass. Record each start load and rc.
- [x] 2.3 Run `pnpm test:docker` and `pnpm test:deploy` on the exact head on the VPS.

## Acceptance mapping (#749)

- Every observation carries a unique label, and a red probe reports it: task 1.1.
- The bounds at `:538` and `:551`, and at any other aggregate site, have an in-band basis, and the ledger is updated and stays under the budget: task 1.2.
- 5 loaded full runs pass, with start load and rc recorded: task 2.2.
- `pnpm lint` and `pnpm typecheck` pass: task 2.1.
