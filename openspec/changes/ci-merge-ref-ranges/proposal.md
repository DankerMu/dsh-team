# Docker-evidence, lockfile and diff-size gates read the merge ref's own range

## Why

Issue #734, found while reviewing #730 (#715). Line numbers refer to main `811f5de`. #715 moved the diff-size count to the merge ref's parents (`HEAD^1...HEAD^2`, `scripts/pr-diff-lines.sh`). The same stale-base pattern remains in two other jobs, and the count itself can still be bypassed.

1. **1a — docker-evidence classifies a stale range** (`.github/workflows/ci.yml:262-269`). On `pull_request`, `RANGE` is `format('{0}...HEAD', github.event.pull_request.base.sha)`. The checkout is the synthetic merge ref, which contains main's current tip. The payload's `base.sha` is not refreshed when main advances (a `labeled` event or a re-run after main moved), so main's newer commits land in the classified range. A docs-only PR can then be judged to need Docker evidence. This fails safe.
2. **1b — lockfile-consistency reads a stale range** (`:343-354`). `git diff --name-only "$BASE_SHA"...HEAD` uses the same payload base and merge-ref `HEAD`. A PR that changes only `pnpm-lock.yaml` passes when main changed a `package.json` after `base.sha`, because that change is counted as the PR's. This fails **open**.
3. **2 — the diff-size count can be bypassed** (`scripts/pr-diff-lines.sh:21-22`). Both reproduced with git 2.49 in the issue.
   - (a) git reads attributes from the work tree, and CI's work tree is the merge ref. A PR that adds a `.gitattributes` with `* -diff` makes every file binary, so `--numstat` prints `-\t-` and the count is 0.
   - (b) `--diff-filter=ACMR` omits `T`. A symlink replaced by a 500-line regular file counts 0.
     Both fail open: a PR over 400 lines can pass `PR diff size guard`.
4. **3 — `lint:pr` base (not changed).** The issue asked to first confirm whether the payload `base.sha` can lag behind main commits already contained in the PR head. Evidence (posted on #734: https://github.com/DankerMu/dsh-team/issues/734#issuecomment-7181811305): in 6 rebased PRs (5 local rebases and 1 server-side `update-branch --rebase`), each `synchronize` payload's `base.sha` equals the head's fork point on main. In 3 `labeled` runs it is the fork point or newer. A newer base still gives `base..head` = the PR's own commits, because the fork point is its ancestor. Every head change fires `synchronize`, so no event carries a base older than the head's fork point. Item 3 is closed with that evidence. The samples cover rebases and `labeled` events, not merge-based syncs; a stale base there could only make `pr-range` red, never pass a commit unchecked. `pr-range` is unchanged.

## What Changes

- **One merge-ref guard.** A new script `scripts/pr-merge-ref.sh` exits 0 only when `HEAD` is a two-parent commit (no `HEAD^3`) whose parents have exactly one merge base. Otherwise it prints a fixed `::error::` line (`HEAD is not a two-parent merge ref; …`, or `HEAD^1 and HEAD^2 do not have exactly one merge base; …`) and exits 1. The diff-size step's inline check (`ci.yml:376-380`) is replaced by it, so docker-evidence, lockfile-consistency and diff-size share one implementation.
- **1a.** On `pull_request`, docker-evidence's `RANGE` becomes `HEAD^1...HEAD^2`, and the scope step first runs the guard on `pull_request` events (it fails the job on a non-merge `HEAD`). On `push`, `before..after` is unchanged.
- **1b.** lockfile-consistency runs the guard, then `git diff --name-only HEAD^1...HEAD^2`. `BASE_SHA` is no longer used there. The step runs only on `pull_request`, as today.
- **2.** `pr-diff-lines.sh` runs `git --attr-source="$from" diff --numstat --diff-filter=ACMRT …`, so attributes come from the trusted base tip, never the PR's tree, and type changes count. `--attr-source` needs git ≥ 2.40. An older git rejects the option, and the script then fails closed with its fixed reason (`exit 2`). It never counts 0. Hosts: ubuntu-24.04 runners, local git 2.49 and Apple Git 2.50.1 all qualify.
- **Docs.** `scripts/README.md` § Diff size and the docker-evidence and lockfile paragraphs, plus `constraints.yaml` `size_limits.max_pr_diff_lines.enforced_by` if its wording changes.
- **Guardrails.** `scripts/test-guardrails.sh` gains red-before/green-after cases for 1a, 1b and 2, run on the real step text extracted from `ci.yml` (existing `ci_step_field` pattern).

## Triage

```text
Issue type: bugfix (CI gates)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: three required PR checks (docker-evidence, lockfile-consistency, diff-size); a wrong change can block every PR or let a lockfile-only or oversized PR through
Selected risk packs: Public API / CLI / script entry; Config / project setup; Legacy compatibility; Error handling; Release / packaging (git version); Documentation
Evidence floor: pnpm test:guardrails red before / green after for each new case; pnpm lint:shell; pnpm lint:ci; pnpm lint:agents; CI on the PR head (the real merge ref) green; exact-head VPS pnpm test:docker + pnpm test:deploy (Docker evidence gate)
```

## Capabilities

### Modified Capabilities

- `pr-range-gates`: the diff-size count reads attributes from the base and counts type changes. The lockfile pairing check reads the merge ref's own range.
- `trusted-docker-verification`: the documentation-only PR range is the merge ref's parents, and a non-merge `HEAD` fails the job.

## Impact

- `.github/workflows/ci.yml` (jobs `docker-evidence`, `lockfile-consistency`, `diff-size-guard`), `scripts/pr-diff-lines.sh`, new `scripts/pr-merge-ref.sh`, `scripts/test-guardrails.sh`, `scripts/README.md`, possibly `constraints.yaml`.
- The PR changes `.github/workflows/` and must say so (AGENTS.md § Agent Operating Rules).
- Out of scope: `pr-range` (item 3, closed with evidence), squash-merge bypass (#715 item 6, a maintainer decision).
