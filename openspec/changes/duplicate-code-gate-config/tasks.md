## Risk packs

- **Config / project setup — selected.** `jscpd.json` becomes live for the first time; its `ignore` gains `**/*.test.tsx` as a second literal entry (no brace glob). Task 1.1.
- **Public API / CLI / script entry — selected.** The root `duplicate-code` script gains `--config jscpd.json`; CI layer 4 (`.github/workflows/ci.yml:133`), `pnpm anti-drift`/`pnpm check` and the guardrail self-test consume it. Name, exit semantics and consumers are unchanged; `.github/workflows/` text is unchanged, and the PR states that layer 4's scan narrows. Task 1.1.
- **Documentation — selected.** AGENTS.md:29, :36, :543 and `constraints.yaml:133` describe the scanned scope; the policy (`*.test.ts`/`*.test.tsx` excluded, test-support modules under `platform/test/` counted) is stated in proposal and PR. Task 1.3.
- **Not selected:** schema, auth/secrets, file IO, concurrency, resource limits, error handling, release/packaging (the gate reads tracked sources and yields pass/fail); legacy compatibility (threshold untouched is a non-goal, not a compatibility surface).

## Must preserve

See `design.md`.

## 1. Implementation

- [ ] 1.1 `package.json` `duplicate-code`: `jscpd platform --config jscpd.json --threshold "$(node scripts/constraints.mjs anti_drift duplicate_code_threshold_percent)"`. `jscpd.json` `ignore`: append `"**/*.test.tsx"`. Evidence: configuration loaded (the normal run prints `Using config from jscpd.json`, or if it does not, the `--debug` merged-config output does and is accepted as the proof), format table lists only typescript/javascript/tsx, no `*.test.ts`/`*.test.tsx` path in the clone list, exit 0; report jscpd's total file count. Negative control: without `--config` the format table lists css/markdown/… again.
- [ ] 1.2 `scripts/test-guardrails.sh` duplicate canary: the corpus filter drops exactly the files `jscpd.json` ignores (`/\.test\.tsx?$/`) on top of the existing extension class, and the comment states the invariant: the counted corpus must never be smaller than the set the gate scans (`jscpd.json` ignore and this filter change together); the stale phrases "(including tests)" and "configuration" in its unchanged-list are dropped. Evidence: `pnpm test:guardrails` under Bash 3.2 and Bash 5 passes with the clean-tree `duplicate code` acceptance and the `duplicate code (two identical N-branch corpus-sized functions)` rejection; report N under each shell (equal) and the canary's filtered file count, which must be ≥ jscpd's reported file count.
- [ ] 1.3 Docs. AGENTS.md:29 → `` `jscpd` (`jscpd.json`) in `pnpm duplicate-code` — fails above 3% of ts/js/tsx lines under `platform/`; `*.test.ts`/`*.test.tsx` excluded, test-support modules counted ``. AGENTS.md:36 → `The duplicate-code guardrail self-test sizes its planted copies from the ts/js/tsx files under platform/ that jscpd.json does not ignore (never fewer than the gate scans) and the configured percentage, with margin for clone accounting. Repository growth therefore does not silently dilute the canary; the threshold is unchanged.` AGENTS.md:543 → `` `jscpd.json` (ts/js/tsx; `*.test.ts`/`*.test.tsx` excluded) ``. `constraints.yaml:133` → `enforced_by: "jscpd --config jscpd.json (ts/js/tsx under platform/, *.test.ts/*.test.tsx excluded; threshold passed from this file)"`. `pnpm lint:agents`, `pnpm fmt:check`, `pnpm lint:config` pass.

## 2. Verification

- [ ] 2.1 `pnpm check`.
- [ ] 2.2 `pnpm test:guardrails` on both shells under quiet host load (5 s fixture timeouts flake above load ≈ 20).
- [ ] 2.3 Exact-head VPS `pnpm test:docker` + `pnpm test:deploy` with confirmed cleanup (the Docker-evidence CI gate requires it per head); CI green.

## Non-goals

See `design.md`.
