## Risk packs

- **Config / project setup — selected.** The CI workflow job and the `constraints.yaml` `enforced_by` fields. Tasks 1.3, 1.5.
- **Public API / CLI / script entry — selected.** The new root `lint:pr`, and a new `--range` mode on the shared `check-naming.sh`. Existing modes are preserved. Tasks 1.1, 1.2, 1.4.
- **Error handling / rollback / partial outputs — selected.** An unreadable range fails closed and is never treated as empty. Tasks 1.1, 1.2, 1.4.
- **Documentation / migration notes — selected.** AGENTS.md, `scripts/README.md`, and spec text that names the third entrypoint. Open PRs with non-conforming commits go red. Task 1.5 and the PR body.
- **Not selected:**
  - Auth / permissions / secrets: no secret is handled. The log shows PR-controlled subjects, which is acceptable.
  - Concurrency / shared state / ordering: there is no shared state, and `lint:ci` passes unchanged.
  - File IO / path safety: the change only reads paths through the existing classifier.
  - Release / packaging / dependency compatibility: no new dependency is added.
  - Schema / columns / units / field names: none.
  - Legacy compatibility: the existing husky and guardrail callers of `check-naming.sh` are covered under Script entry, and the existing modes are preserved.

## Acceptance-criteria mapping (#665)

- **AC1** (a commitlint violation in a PR fails the required check) → 1.1, 1.3, 1.4.
- **AC2** (a naming violation fails the check; the archive exemption is accepted) → 1.2, 1.3, 1.4.
- **AC3** (the range starts at the PR base; a push to `main` is never red) → 1.1, 1.3, 1.4. The base-history accept case and the unreadable-range rejection gate this. Item 2.2 is a post-merge report.
- **AC4** (a guardrail reject and accept case for each gate) → 1.4.
- **AC5** (`pnpm lint` passes, including `lint:agents`, `lint:ci` and `lint:shell`; the new commands are root scripts) → 2.1.
- **AC6** (the Enforcement Index no longer implies hooks; the PR flags the workflow and AGENTS.md changes) → 1.5, plus the PR body.

## Must preserve

See design.md § Must preserve.

## 1. Implementation

- [ ] 1.1 Add `scripts/check-pr-range.sh <base> <head>` and the root script `lint:pr`.
  - The script runs commitlint over `base..head`.
  - It runs naming over the paths that `base...head` adds or renames.
  - It runs a preflight before either check: two args, both SHAs verified, and a merge base found. Otherwise it fails with `lint:pr: unreadable range`.
- [ ] 1.2 Add `--range <base> <head>` to `check-naming.sh`, following design.md § Must add/change: parse it before the path branch, check its own `git diff` status, and keep exit code 1 and the existing text. It shares `path_violations`, and the existing modes are unchanged.
- [ ] 1.3 Add the CI job `pr-range` and include it in `all-checks-passed`.
  - Check out with `fetch-depth: 0`, then set up node and pnpm and install.
  - On `pull_request`, run `pnpm lint:pr "$BASE_SHA" "$HEAD_SHA"` with `base.sha` and `head.sha`.
  - On push, the step is skipped and the job succeeds.
  - `pnpm lint:ci` must pass.
- [ ] 1.4 Add the guardrail cases listed in the proposal, using the `$wt` mechanism in design.md § Seams under test with a reset in a `finally`-equivalent. Run them under both Bash 3.2 and Bash 5. Add `range` to the missing-policy loop (`test-guardrails.sh:180`).
- [ ] 1.5 Update the docs:
  - AGENTS.md `:292-293` (hook files plus `pnpm lint:pr` in CI), Local setup (`core.hooksPath` is `.husky/_` via `prepare`; do not override it), and `:321`;
  - `scripts/README.md` `:11`, `:15`, `:16`, `:20`, and the `check-naming.sh` header;
  - the AGENTS.md Daily commands "CI gates" line;
  - keep the Enforcement Index cells within their current column widths.
  - `constraints.yaml` `:79`, `:84`, `:167`.

## 2. Verification

- [ ] 2.1 Make sure this PR's own commits pass commitlint: subject ≤72 characters, header and body lines ≤100, and a blank line before the trailer. Run `pnpm lint` (including `lint:ci`, `lint:agents` and `lint:shell`), `pnpm test:guardrails` and `pnpm check`. Also run `pnpm lint:pr` on this branch's own range (green) and on a scratch range with a bad commit (red), and record both.
- [ ] 2.2 This PR's CI shows `pr-range` running on its range. After merge, a reviewer checks the push run, where the step is skipped and the job is green. This item is reported, not a merge gate.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
