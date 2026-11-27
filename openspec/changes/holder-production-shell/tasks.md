## Risk packs

- **Concurrency, shared state and ordering (selected).** The window in which a signal can be delivered. Covered by the probe (tasks 1.1 and 2.1).
- **Legacy compatibility (selected).** #741's measured basis was taken under bash. The comment must say so (task 1.2).
- **Not selected:** file IO, error handling, public API, config, secrets, resource limits, release and docs. The change is limited to the test's interpreter and one comment.

## Must preserve

- `deploy/document-server-net.sh` and `deploy/compose.yml`.
- `EXIT_MS`, `expect(bound).toBe(EXIT_MS)`, the `CASE_TIMEOUT_MS` formula and every assertion.
- The measured-basis lines that #753 added to the `EXIT_MS` comment (load bands, host, the 2 ms and 7 ms maxima). Only the #752 line is rewritten.
- `holder()`'s 20 ms poll and its single SIGTERM. The test gets no second TERM and no retry.
- The stubs, `PATH` and the `detached` group kill.
- No fallback shell: if `/bin/dash` is missing, the case fails.
- The probe is not committed.

## 1. Implementation

- [x] 1.1 Red probe, kept outside the repository in the session scratchpad. It reproduces the issue's conditions:
  - It runs the original script against the test's stubs.
  - It polls tightly for the marker, not every 20 ms.
  - After the marker appears it waits a random offset of 0–3000 µs, then sends a single TERM to the script PID only.
  - 6 drivers run in parallel at idle-to-moderate load (the issue saw 7.7–9.5); the 1-minute load is recorded with the results.
  - Half the rounds run with `STUB_DELAY='ip6tables -S'` and half without.
  - A hang means the script is still running `EXIT_MS` after the TERM. On a hang, the probe sends a second TERM and records whether the script exits 0 within 2 s.
  - Every round ends by killing the group.
  - N counts total rounds across all drivers, with N ≥ 3000 under `/bin/sh` (bash 3.2). Record K hangs. If K < 3, stop and report a blocker; the task is not done.
- [x] 1.3 Record the production shell evidence:
  - the exact command that lists the layers of the linux/amd64 platform image built from `c016b84`, and its output, including the last layer that touches `usr/bin/sh`;
  - the image identity;
  - the product-impact statement that follows, labelled as inference because the image's dash was not probed.
- [x] 1.2 Change the test to `spawn('/bin/dash', …)`, with the #752 comment and an explicit existence check that throws naming `/bin/dash`. Rewrite the `EXIT_MS` comment's #752 line: the test runs dash, which is the image's `/bin/sh`, and #741's maxima were measured under bash.

## 2. Verification

- [x] 2.1 Run the same probe under `/bin/dash`, with the same conditions and the same N: 0 hangs, and every round exits `code: 0` within `EXIT_MS`.
- [x] 2.2 `pnpm exec vitest run --project integration platform/test/document-server-net-script.integration.test.ts`, `pnpm lint` and `pnpm typecheck` exit 0.
- [x] 2.3 Run 5 consecutive full `pnpm test:integration` runs, each started at 1-minute load ≥ 13 and < 67 with bounded `yes` generators. All must pass. This is a regression check; the probe carries the proof.
- [ ] 2.4 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`.

## Acceptance mapping (#752)

- Red probe on bash 3.2 with N bounded and K hangs, killing the process group every round: task 1.1.
- The same probe on the shell under test, with 0 hangs in N rounds: task 2.1.
- The production image's `/bin/sh` is recorded with the command and its output, and product impact is stated as inference: task 1.3.
- `expect(bound).toBe(EXIT_MS)` and the `CASE_TIMEOUT_MS` formula are kept: Must preserve.
- 5 full loaded runs on macOS: task 2.3.
