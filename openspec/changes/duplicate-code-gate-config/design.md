# Design: duplicate-code gate configuration

Change surface: `package.json` `duplicate-code` script; `jscpd.json` `ignore`; `scripts/test-guardrails.sh` duplicate canary (corpus filter and comment, ~lines 397-438); `constraints.yaml` `anti_drift.duplicate_code_threshold_percent.enforced_by`; AGENTS.md lines 29, 36 and 543.

Must preserve: `pnpm duplicate-code` exits nonzero above the configured threshold and zero on the clean tree; the threshold is read only from `constraints.yaml` through `scripts/constraints.mjs`; the guardrail self-test keeps its complete case inventory under macOS Bash 3.2 and Bash 5 (literal Node heredoc outside command substitution, ten-row minimum, `target >= 50` guard, clean-tree `duplicate code` acceptance at line 112 and the corpus-sized rejection); the two planted copies and their rejection reason (`threshold`); `.github/workflows/` text; the `jscpd.json` file name and `gitignore: true`.

Must add/change: `--config jscpd.json` on the script; `"**/*.test.tsx"` as a second literal ignore entry; the canary corpus filter drops exactly `/\.test\.tsx?$/` on top of the existing `/\.(?:[cm]?[jt]s|[jt]sx)$/` extension class; documentation describes the scanned scope (ts/js/tsx under `platform/`, `*.test.ts`/`*.test.tsx` excluded, test-support modules counted).

Governing invariant: the corpus the canary counts is a superset of the set `jscpd --config jscpd.json` scans under `platform/`, so planted copies sized from it always exceed the threshold against the real scan. `jscpd.json`'s ignore list and the canary filter change together, never separately.

Sibling surfaces: `package.json` `duplicate-code` (entry); `jscpd.json` (scope); `scripts/test-guardrails.sh:112` (clean-tree acceptance) and `:397-438` (canary); AGENTS.md:29/36/543 and `constraints.yaml:133` (descriptions); CI layer 4 `.github/workflows/ci.yml:133` and `pnpm anti-drift`/`pnpm check` (consumers, unchanged text).

Seams under test: the root script as CI runs it (`pnpm duplicate-code`) and the guardrail self-test as both shells run it (`pnpm test:guardrails`).

Required evidence: `pnpm duplicate-code` on the clean tree → configuration loaded (the `--debug` merged config shows `Using config from jscpd.json` with the configured formats/ignores, or the normal run prints that notice), format table lists only typescript/javascript/tsx, no `*.test.ts`/`*.test.tsx` among clones, exit 0, total well below 3%; canary sizing program → N and filtered file count, with the count ≥ jscpd's reported file count; `pnpm test:guardrails` under Bash 3.2 and Bash 5 → full inventory passes, equal N; negative control: without `--config` the format table again lists css/markdown/… .

Non-goals: changing the 3% threshold; refactoring tests to reduce clones (#504 covers `isPlainObject`); extending the gate beyond `platform/`; brace-glob ignores.

Review focus: (1) the canary filter is exactly the ignore list, not broader; (2) no gate weakened (threshold, planted copies, rejection reason unchanged); (3) Bash 3.2 parsing of the edited heredoc; (4) AGENTS.md:36 no longer claims the command and exclusions are unchanged; (5) CI narrowing disclosed.
