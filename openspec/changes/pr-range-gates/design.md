# Design

## Change surface

- The CI workflow job.
- The `lint:pr` root script and `scripts/check-pr-range.sh`.
- The `check-naming.sh` range mode.
- Guardrail cases.
- Documentation and the `enforced_by` fields.

## Must preserve

- `check-naming.sh`'s path-argument mode and staged mode, including their exit codes (2 and 1) and messages, and the shared classifier with the #199 archive exemption.
- The `.husky/pre-commit` and `.husky/commit-msg` hooks.
- `commitlint.config.cjs` rules, unchanged.
- Every existing CI job. The aggregator semantics stay as they are: it fails when any job fails, is cancelled or is skipped.
- `pnpm lint:ci` (`scripts/check-ci-concurrency.mjs`): the concurrency policy still passes.
- Existing guardrail cases.
- The 120 historical commits, which are not rewritten.
- **Bash 3.2 safety:** both `check-naming.sh` and `check-pr-range.sh` stay bash-3.2-safe (no `mapfile`, no bash-4 syntax; `check-naming.sh:14`). The new guardrail cases run under both Bash 3.2 and Bash 5, as the guardrail specification requires.
- **Strict archive rejection:** range mode keeps rejecting archive paths when `managed_archive_pattern` or `constraints.yaml` is missing (`test-guardrails.sh:179-197`).

## Must add/change

- **Fail-closed `check-pr-range.sh`.** See proposal § What Changes.
- **`check-naming.sh --range <base> <head>`.**
  - It is parsed before the `$# -gt 0` path-argument branch, so `--range` is never classified as a path.
  - It checks the status of its own `git diff` and fails on error.
  - It keeps the staged mode's exit code 1 and the violation text (`forbidden naming suffix` / `scratchpad directory`).
- **The `pr-range` CI job.**
  - Its actions are pinned to the same SHAs as the other jobs.
  - It has a `name:`, a `timeout-minutes`, and `persist-credentials: false`.
  - Setup, install and run steps are all gated on `pull_request`.
  - SHAs are passed through `env:`.
  - commitlint prints PR-controlled subjects to the log. No later step reads its outputs, so stop-commands wrapping is not needed.

## Governing invariant

A PR's required check fails if any commit in that PR violates commitlint, or if any path the PR adds or renames violates naming. It never fails because of commits or paths that are not in that PR. A push to `main` is never failed by this job.

## Decisions

- **Inside the aggregator, with a conditional step.** Branch protection requires only `All checks passed`, `PR diff size guard` and `Lockfile-manifest consistency`. Putting the job inside the aggregator gives it a required status without changing GitHub settings. Making only the step conditional means the job is never "skipped", so the aggregator rule holds.
- **Use `pull_request.head.sha` as the head.** Using the merge ref would add only the synthetic `Merge X into Y` commit, which commitlint ignores by default. It would also add any base commits between a stale `base.sha` and the base that GitHub used for the merge ref. `head.sha` names the PR's own commits directly. It is the second parent of the merge ref, so it is present with `fetch-depth: 0`, fork PRs included.
- **One script for both checks.** A single root command keeps the CI step and the guardrail cases on the same entrypoint (KISS).
- **Range mode reuses `path_violations`.** It reads `git diff --name-only --diff-filter=AR base...head` instead of the cached index, so there is one classifier.

## Sibling surfaces

- `docker-evidence` already computes `base...HEAD` (`ci.yml:226-227`). This job uses explicit SHAs instead, for the reason above.
- The diff-size and lockfile jobs are unchanged.

## Seams under test

Guardrail cases run in `$wt`, the guardrail worktree that already has `package.json`, `node_modules` and the configs.

1. Record `baseline="$(git rev-parse HEAD)"` once.
2. For each case, commit with `-c user.name=guardrails -c user.email=guardrails@localhost` (as at `:46`), then run `pnpm lint:pr <base> HEAD`.
3. Afterwards, always run `git reset --quiet --hard "$baseline"` and `git clean -fdq`, even when the case fails, so no fixture leaks into later sections.

The base-history accept case first commits its non-conforming base on top of `baseline`, then builds the range on top of that.

## Required evidence

- **Guardrails.** All cases listed in the proposal pass under Bash 3.2 and Bash 5. The rejections match a named reason:
  - the commitlint rule name;
  - `forbidden naming suffix` / `scratchpad directory`;
  - `lint:pr: unreadable range`.
- **CI.** This PR's own CI run shows `pr-range` executed on its range and green. The push run on `main` after merge must show the step skipped and the job green; a reviewer checks this after merge.
- **Lint.** `pnpm lint` passes, including `lint:ci`, `lint:agents` and `lint:shell`.

## Non-goals

- Rewriting history.
- Changing commitlint rules.
- Renaming `.git-hooks/`.
- The `.claude/` templates.

## Review focus

- Range correctness: merge commit, base drift, a force-pushed PR.
- The aggregator is never skipped.
- No false red on `main`.
- The documentation no longer misleads.
