## 1. Implementation

- [ ] 1.1 Add phase receipt publication (entered/completed/failed) around admission, checkout, install, build and driver in `platform/test/ci-vps-worker.ts`, using the existing atomic `writeReceipt`.
- [ ] 1.2 Derive closed-set failure category, exit status and signal from spawn results; carry last phase/category into `execution.json` without changing `exitCode` semantics.
- [ ] 1.3 Remove raw preparation stdout pass-through from `command()`.
- [ ] 1.4 Validate `execution.json` in `performFinalization()`; fail closed to exitCode 1; keep `final.json` shape exact.
- [ ] 1.5 Update AGENTS.md model-lane paragraph to name `phase.json` and its closed fields.

## 2. Tests

- [ ] 2.1 Real worker-entry integration regression for every Required-evidence failure row in design.md (nonzero, signal, timeout, output-limit, spawn-error, identity-mismatch, admission-expired by expiry and by cancel), exact deep-equal receipts, each RED before and GREEN after.
- [ ] 2.2 Interrupted build phase (worker spawned detached, process group SIGKILLed, no fake survives) leaves `{version:1, phase:'build', state:'entered'}` and no `execution.json`.
- [ ] 2.3 Driver success/nonzero recorded as driver phase; existing exitCode semantics unchanged; `execution.log` absent after prep failure.
- [ ] 2.4 Canary exclusion (args, stdout/stderr, thrown error, proxy env, DMXAPI_KEY) across receipts and worker stdout/stderr; `[REDACTED]` in execution.log; 0600 regular-file checks.
- [ ] 2.5 `finalize-locked` after real execute success/failure (systemctl fake answering not-found): exact `final.json`, accepted by the owner via the `ci-vps-owner-fixture.ts` fake-ssh receipt path (extending that fixture with a mode that returns the real `final.json` bytes is in scope); malformed/oversized/out-of-range `execution.json` → exitCode 1.
- [ ] 2.6 Existing `browser-build` / `ci-vps-owner` integration suites still pass.

## 3. Verification

- [ ] 3.1 `pnpm check:fast`
- [ ] 3.2 `pnpm test:integration` for the new regression plus existing ci-vps / browser-build integration files (Linux semantics via preload as existing fixtures do).
- [ ] 3.3 `openspec validate retain-model-worker-phase-evidence --strict --no-interactive`

## Risk packs

- File IO / path safety — selected: new private receipt in invocation dir, written only after approval validation → 2.4 mode/type checks, atomic writeReceipt.
- Auth / permissions / secrets — selected: process output may carry credentials/proxy values → 2.4 canary exclusion.
- Schema / field names — selected: new receipt fields, closed sets → 2.1/2.2 exact-shape assertions.
- Error handling / partial outputs — selected: phase entered before work so interruption still leaves evidence → 2.1, 2.2.
- Legacy compatibility — selected: owner/finalizer consume execution/final receipts; worker module closure in the trusted archive → 2.5, 2.6, design must-preserve.
- Documentation — selected: AGENTS.md → 1.5.
- Public API / CLI entry — not selected: worker modes and arguments unchanged.
- Config / project setup — not selected: no new environment inputs.
- Concurrency / shared state / ordering — selected: `watch`/`finalize` run alongside `execute` and key off `execution.json` → write-order must-preserve, 2.2/2.5.
- Resource limits — selected only as evidence: existing deadline and 16MiB maxBuffer classified as timeout/output-limit (2.1); changing limits is a non-goal.
- Release / packaging — not selected.
