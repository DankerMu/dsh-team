# Design

Change surface: `.github/workflows/ci.yml` steps "Detect documentation-only change" (job `docker-evidence`), "Check lockfile–manifest pairs" (job `lockfile-consistency`) and "Enforce max PR diff lines" (job `diff-size-guard`); `scripts/pr-diff-lines.sh`; new `scripts/pr-merge-ref.sh`.

Must preserve:

- Push events: docker-evidence still classifies `before..after`, and no merge-ref guard runs on push (the checkout is the pushed commit, which may have one parent).
- docker-evidence's NUL-delimited, byte-exact listing, temp-file stdin, stop-commands token wrapping, `docs_only` output and exit-code contract (classifier exit 1 = evidence required, any other non-zero fails the step). Every existing `scope_case` guardrail passes, with only `GITHUB_EVENT_NAME=push` pinned in its harness and `pr-merge-ref.sh` copied into its repository.
- The docs-only classifier itself (`scripts/docs-only-diff.sh`) is unchanged.
- lockfile-consistency: the `lockfile-refresh` label still skips the step; lockfile plus `package.json` in the PR still passes; the error text is unchanged.
- diff-size: `diff-limit-exempt` label `if:` unchanged; the existing counts (dash-leading/blank lines, stale payload base), binary files count 0 (content-detected), deleted files uncounted, lockfile and `schemas/openapi.json` excluded; every fail-closed case (`size_rejects`, non-merge and octopus `HEAD`) still fails with its reason and no count; bash 3.2 compatible.
- The aggregator `all-checks-passed` and `pnpm lint:ci` concurrency policy are unaffected.

Must add/change:

- `scripts/pr-merge-ref.sh`: no arguments; `git rev-parse --verify --quiet 'HEAD^2^{commit}'` must succeed, `HEAD^3` must not resolve, and `git merge-base --all HEAD^1 HEAD^2` must print exactly one commit (review round 1: a criss-cross history gives several merge bases, and git's three-dot diff silently picks one, so a lockfile-only or code-reverting PR passed). Otherwise a fixed `::error::` line and exit 1. bash 3.2 compatible, shellcheck clean.
- docker-evidence `RANGE`: `github.event_name == 'pull_request' && 'HEAD^1...HEAD^2' || format('{0}..{1}', github.event.before, github.event.after)`. Its scope step runs `bash scripts/pr-merge-ref.sh` first when `GITHUB_EVENT_NAME` is `pull_request`.
- lockfile-consistency: guard, then `changed="$(git diff --name-only 'HEAD^1...HEAD^2')"`; drop the `BASE_SHA` env.
- diff-size: inline two-parent check replaced by the guard script.
- `pr-diff-lines.sh`: `git --attr-source="$from" diff --numstat --diff-filter=ACMRT …`; header comment states the attribute source, `T`, and the git ≥ 2.40 requirement (fails closed below it).

Governing invariant: each PR gate reads exactly the PR's own changes, `merge-base(HEAD^1, HEAD^2)..HEAD^2`, with attributes read from the base tip, and fails closed when that range cannot be formed.

Sibling surfaces:

- `pr-range` (`pnpm lint:pr "$BASE_SHA" "$HEAD_SHA"`): reads `base..head`, not the merge ref. Item 3 evidence shows no reachable stale-base case; unchanged.
- `scripts/check-pr-range.sh` / `check-naming.sh` range mode: unchanged.
- `platform/test/verify-docker-evidence.ts` and `platform/test/docker-evidence-github.ts` (`pnpm verify:docker-evidence`): read the head from the event payload and its status, not a range; unchanged.
- Guardrail harness itself: the `guardrails` CI job runs on `pull_request` and inherits `GITHUB_EVENT_NAME=pull_request`, so `scope_case` must pin `GITHUB_EVENT_NAME` (`push` for the existing one-parent cases) and both `scope_repo` and `size_fixture` must copy `scripts/pr-merge-ref.sh`. Local green does not prove this; only CI on the PR does.
- Main push path of docker-evidence (`before..after`): unchanged; guard not run.
- Local `pnpm test:guardrails` on macOS: must run with the host git (≥ 2.40).

Seams under test: the real step `run` text and `env` fields extracted from `ci.yml` (`ci_step_field`) run in throwaway repositories with a synthetic merge commit and a stale payload base; `pr-diff-lines.sh` and `pr-merge-ref.sh` run directly.

Required evidence (each red on main's step text or script, green after):

- 1a: the extracted `env.RANGE` equals the new expression exactly; this is the red-before case (on main it is the `base.sha...HEAD` expression). Behavioural companion: fixture with base B, main adds `platform/x.ts` after B, the PR adds only `docs/a.md`, `HEAD` = merge(main tip, PR); the scope step with `RANGE='HEAD^1...HEAD^2'` and `GITHUB_EVENT_NAME=pull_request` → `docs_only=true`, and with main's range `B...HEAD` → `evidence required: platform/x.ts` (shows what the expression change fixes). Non-merge `HEAD` with `GITHUB_EVENT_NAME=pull_request` → the step fails with the guard's fixed `::error::HEAD is not a two-parent merge ref; cannot read the PR range.` line and `docs_only` is unset (on main: the line is absent).
- 1b: base B, main changes `package.json` after B, the PR changes only `pnpm-lock.yaml`, merge `HEAD`, stale `BASE_SHA=B` → step exits 1 with the lockfile `::error::` (on main: passes). A PR with both lockfile and `package.json` → passes. Non-merge `HEAD` whose single commit changes both `pnpm-lock.yaml` and `package.json` → fails with the guard's fixed line (on main: passes).
- 2a: the PR adds a `.gitattributes` with `* -diff` plus a 300-line file → the real step prints `Changed lines …: 301 (limit: 400)` and exits 0 (on main: `: 0`).
- 2b: the PR replaces a symlink with a 500-line regular file → `pr-diff-lines.sh HEAD^1 HEAD^2` run directly prints `501` (on main: `0`). Seam is the script, because 501 exceeds the 400 limit and the step would fail on the limit.
- `pr-merge-ref.sh`: two-parent with one merge base → 0; one-parent → 1 with the fixed line; octopus → 1; criss-cross (two merge bases) → 1 with a fixed line.
- Criss-cross through the real steps: the lockfile step (PR changes only `pnpm-lock.yaml`, main's `x/package.json` reachable from the second base) → exit 1 with the guard line (red at `d84ca86`: passes); the docs-only scope step under `pull_request` → fails, `docs_only` unset (red at `d84ca86`: `docs_only=true`); the diff-size step → fails with no count.
- All existing guardrail cases pass; `pnpm test:guardrails` exit 0.
- CI on the PR head runs the real jobs on the real merge ref: docker-evidence, lockfile-consistency and diff-size guard all succeed.

Non-goals: content-detected binaries (a PR can still add a NUL byte to a large text file and have it count 0; the issue rejected `--text`, which would count real binaries); changing `pr-range`; changing the docs-only classifier; counting deleted files; changing squash-merge settings.

Review focus:

- Push events: no guard, `before..after` intact; `RANGE` expression correct for both events.
- No new fail-open path: an older git or a failing `git diff` never yields a count or a pass.
- The guardrail cases run the real extracted step text, not a copy.
- Workflow change flagged in the PR description.
