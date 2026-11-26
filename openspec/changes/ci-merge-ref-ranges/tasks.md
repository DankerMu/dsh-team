## Risk packs

- **Public API / CLI / script entry (selected).** New `scripts/pr-merge-ref.sh`; `pr-diff-lines.sh` options. Tasks 1.1, 1.4; shellcheck via `pnpm lint:shell`.
- **Config / project setup (selected).** `.github/workflows/ci.yml` step text and `env`. Tasks 1.2, 1.3, 1.4; `pnpm lint:ci`; CI on the PR head.
- **Legacy compatibility (selected).** Push-event range, labels' `if:`, existing guardrail cases, error texts. Task 2.1 (all existing guardrails green); design "Must preserve".
- **Error handling (selected).** Fail closed on a non-merge `HEAD` in all three jobs and on an old git. Tasks 1.1–1.4 fail-closed cases.
- **Release / packaging (selected).** `--attr-source` needs git ≥ 2.40; below it the script fails closed. Task 1.4 (header comment, fail-closed reason unchanged); checked hosts: ubuntu-24.04 runner (CI on the PR head), local git 2.49.
- **Documentation (selected).** `scripts/README.md` paragraphs for diff size, docker-evidence and lockfile; `constraints.yaml` `enforced_by`. Task 1.5; `pnpm lint:agents`.
- **Not selected:**
  - File IO / path safety: the scripts only read git; no writes outside the guardrail temp repos.
  - Schema / auth / secrets: no tokens or payload fields added; `persist-credentials` unchanged.
  - Concurrency: `pnpm lint:ci` (unchanged policy) still passes.
  - Resource limits: ranges are bounded by the PR.

## Must preserve

See `design.md` § Must preserve. In particular every existing `scope_case`, `size_case`, `size_rejects` and docs-only `expect_*` case passes unchanged.

## 1. Implementation

Write each guardrail case first against main's step text and record its red output, then change the code.

- [ ] 1.1 `scripts/pr-merge-ref.sh` (two-parent check, fixed `::error::` line, exit 1). Cases: two-parent → 0; one-parent → 1; octopus → 1.
- [ ] 1.2 docker-evidence: `RANGE` expression and the `pull_request` guard. Harness first: `scope_case` pins `GITHUB_EVENT_NAME=push` for the existing cases and copies `scripts/pr-merge-ref.sh` (if present) into `scope_repo`. Cases: exact `env.RANGE` text (red on main); stale base + main adds `platform/x.ts` + PR adds only `docs/a.md`, merge `HEAD`, `GITHUB_EVENT_NAME=pull_request`, `RANGE='HEAD^1...HEAD^2'` → `docs_only=true`; non-merge `HEAD` under `GITHUB_EVENT_NAME=pull_request` → step fails with the guard's fixed line, no output (red on main: line absent); the existing cases under `push` on a one-parent commit → classified as before, no guard.
- [ ] 1.3 lockfile-consistency: guard + `HEAD^1...HEAD^2`. Cases: stale base + main changes `package.json` + PR changes only `pnpm-lock.yaml` → exit 1 with the lockfile error (red on main: passes); lockfile + `package.json` in the PR → passes; non-merge `HEAD` whose commit changes both `pnpm-lock.yaml` and `package.json` → fails with the guard's fixed line (red on main: passes).
- [ ] 1.4 diff-size: guard script replaces the inline check (existing non-merge and octopus cases keep passing, reason text may move to the guard's line — update the expected text in the same change only if it changes); `pr-diff-lines.sh` gets `--attr-source="$from"` and `ACMRT`. `size_fixture` copies `scripts/pr-merge-ref.sh`. Cases: `.gitattributes` `* -diff` + 300-line file → the real step's `Changed lines …: 301 (limit: 400)`, exit 0 (red on main: `: 0`); symlink → 500-line file → `pr-diff-lines.sh HEAD^1 HEAD^2` run directly prints `501` (red on main: `0`; 500 added + 1 removed; the script is the seam because 501 exceeds the limit).
- [ ] 1.5 Docs: `scripts/README.md` (§ Diff size, docker-evidence PR range, lockfile pairing, guardrail list at `:37`), `constraints.yaml` `enforced_by` wording if needed.

## 2. Verification

- [ ] 2.1 `pnpm test:guardrails`: exit 0, new cases PASS (red output for each recorded from main's step text).
- [ ] 2.2 `pnpm lint:shell`, `pnpm lint:ci`, `pnpm lint:agents`, `pnpm lint`, `pnpm fmt:check` (tracked files): exit 0.
- [ ] 2.3 CI on the PR head green (the `guardrails` job is the only proof that the harness pins `GITHUB_EVENT_NAME` correctly under `pull_request`), in particular `Trusted Docker and Compose evidence`, `Lockfile-manifest consistency` and `PR diff size guard` on the real merge ref.
- [ ] 2.4 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy` (Docker evidence gate; the diff is not docs-only).
- [ ] 2.5 Post item 3's evidence on #734.
