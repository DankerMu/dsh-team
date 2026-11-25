# Design

**Change surface:** the CI steps for diff-size-guard and docker-evidence docs-only detection; `commitlint.config.cjs` (one `ignores` entry); `constraints.yaml` `enforced_by` text; `scripts/pr-diff-lines.sh` (new), `scripts/docs-only-diff.sh`, `scripts/check-pr-range.sh` and `.git-hooks/check-naming.sh` in range mode; `scripts/test-guardrails.sh`.

**Must preserve:**

- **Diff count.**
  - The limit still comes from `constraints.yaml` (`size_limits.max_pr_diff_lines`, 400).
  - `pnpm-lock.yaml` and `schemas/openapi.json` stay excluded.
  - Deleted files stay uncounted (`--diff-filter=ACMR`), and whitespace is still ignored.
  - The `diff-limit-exempt` label still skips the step (`if:`).
  - A count that cannot be computed fails. It never prints 0.
- **docs-only classifier.**
  - Exit 0 still means docs-only, 1 means evidence is required, 2 means unreadable.
  - Its grammar is unchanged: Markdown outside `plugins/` and `images/`, plus root-anchored `.openspec.yaml`. It stays bash 3.2 compatible.
  - The CI step's rc handling and its stop-commands wrapping are unchanged.
- **Naming.**
  - Staged mode and path mode behave as before.
  - In range mode, every existing guardrail case still passes, including `range_history`, which relies on `M` entries being ignored.
  - Every path the net diff reports today is still reported, including paths that only a merge commit adds.
  - Range mode with no merge-base still fails.
- **`lint:pr`** keeps its existing reasons and exit codes for wrong arguments and unresolvable refs.
- **commitlint config.** All rules stay unchanged. The one `ignores` entry matches only a Dependabot-shaped subject that also carries the Dependabot signed-off trailer.

**Must add:** the behaviors listed in proposal.md § What Changes.

**Governing invariant:** each PR gate judges exactly the PR's own changes. That means its own lines, its own added paths in every commit, and its own commit subjects, and it reads paths byte-exactly, whatever the base drift or the path encoding.

**Sibling surfaces:**

- **docker-evidence `RANGE` and lockfile-consistency.** Both still use the stale `base.sha...HEAD` pattern. That is out of scope: it is reported in the PR, not changed here.
- **Docker-evidence push mode** (`before..after`). It shares the classifier, so its NUL input must be produced the same way in that branch of the step.
- **`check-naming.sh` staged mode.** It already uses `-z` (#665) and is unchanged.
- **Every existing PR.** The new count is never higher than the old one for an up-to-date base, apart from the lines starting with `+`/`-` and the blank lines that the old count missed.

**Seams under test:** `scripts/test-guardrails.sh` runs the real scripts and the real CI step text, extracted from `ci.yml` with the `yaml` package as `scope_step`/`scope_case` do, against throwaway git fixtures.

- **Diff size.** The `Enforce max PR diff lines` step text runs inside a fixture repo that has a real `git merge --no-ff` merge commit as `HEAD` and a stale `BASE_SHA`. A missing script would make a case red for the wrong reason, so the diff-size cases are not satisfied by calling the script directly.
- **Docs-only.** The non-ASCII and multi-path cases run through `scope_case`, the real git output. The `docs_only()` helper would hide quoting.

**Required evidence** (each case red before the change, green after; red output recorded):

- **#1, step text.** One commit adds `+- foo`, `-- bar` and two blank lines. The step prints the exact count, 4 here. The old grep printed 0.
- **#2, step text.** The base gains two commits after the branch point, with plain text lines only, so the case does not depend on #1. The merge fixture has a stale `BASE_SHA`. The count equals the PR's own lines; the old range counted the base's lines as well.
- **#1/#2.** A binary file counts as 0.
- **Fail-closed.** The script exits non-zero with its fixed reason and prints no count for:
  - a wrong argument count;
  - an unresolvable ref;
  - `HEAD^2` missing, because `HEAD` is not a merge.

  Through the step text, the step fails when `HEAD` is not a merge. The old step counted `BASE_SHA...HEAD` and passed.

- **Label exemption.** The extracted step's `if:` still contains `diff-limit-exempt`.
- **#3, `scope_case`.**
  - `docs/笔记.md` alone gives `docs_only=true`. The old run printed `evidence required: "docs/\347…md"`.
  - `docs/a.md`, `platform/x.ts` and `z.md` give `evidence required: platform/x.ts` and an empty `GITHUB_OUTPUT`. Git emits them as doc, code, doc. The old line reader, given this NUL stream (the half-changed state: `-z` in the step, the old reader in the classifier), judged it docs-only on bash 3.2 and bash 5. On fully unchanged code the step is newline-delimited, so the case is green there. This case guards the NUL reader; a single-path case cannot.
  - After `docs_only()` switches to `printf '%s\0'`, every existing classifier case keeps its result.
- **#4.**
  - commitlint rejects `build(deps): Bump x from 1 to 2` with no trailer, on `subject-case`.
  - It accepts #612's real full message, with `Bump` and the `Signed-off-by: dependabot[bot] <support@github.com>` trailer. The old config rejected it.
  - It rejects a non-Dependabot subject that carries the trailer, e.g. `feat(x): Add y`.
  - It rejects a Dependabot subject with another bad rule, e.g. type `oops(deps): Bump …`.
- **#5.**
  - One commit adds `tmp/x.md` and the next deletes it. The range is rejected with the scratch reason; the old check accepted it.
  - A path added only inside a merge commit is still rejected, both before and after the change.
  - All existing `range_*` cases stay green.
- **#7.** `pnpm lint:pr X X` exits 2 with `lint:pr: unreadable range`. The old run printed commitlint usage.

**Non-goals:**

- Repository merge settings (#6, maintainer decision).
- The sibling stale ranges named above.
- Changing `.github/dependabot.yml`. Its prefix cannot change Dependabot's capitalisation (proposal § Decision).

**Review focus:**

- `HEAD^1`/`HEAD^2` hold in a `pull_request` merge-ref checkout. The diff-size job uses `fetch-depth: 0`.
- NUL handling on bash 3.2, plus empty-input behavior.
- `git log -z --format=` parsing: empty fields, and the union with the net diff.
- The narrowness of the commitlint `ignores` predicate.
- No existing guardrail case is weakened.
- The PR flags the `.github/workflows/` change.
