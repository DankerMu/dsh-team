# Make the PR gates count, classify and name-check the PR's own range

## Why

Issue #715. Line numbers refer to main `a4efa57`. In each item below, a PR gate miscounts, misreads or misses something.

1. **diff-size guard undercounts.** `.github/workflows/ci.yml:372-373` counts lines with `grep -c '^[+-][^+-]'`. That pattern skips added or removed lines whose content itself starts with `+` or `-`, such as a Markdown `+- foo`, and it skips blank changed lines.
2. **diff-size guard overcounts.** The same step diffs `pull_request.base.sha...HEAD`, where `HEAD` is the synthetic merge commit. When the base advances, the payload's `base.sha` is not refreshed, so new commits on main get counted as part of the PR. One run measured 1014 lines for a PR of about 329.
3. **docs-only classifier misreads non-ASCII paths.** The docker-evidence step pipes `git diff --no-renames --name-only`, without `-z`, into `scripts/docs-only-diff.sh`. Git quotes non-ASCII paths, so a file ending in `.md` arrives as `….md"` and no longer looks like documentation. The PR then needs Docker evidence. This fails safe.
4. **Dependabot PRs always fail `pr-range`.** `.github/dependabot.yml` has no `commit-message`. The default title, `build(deps): Bump …`, violates config-conventional's `subject-case`. A local commitlint run reports `✖ found 1 problems`.
5. **Naming gate checks only the net diff.** `.git-hooks/check-naming.sh:107,129` checks the net `base...head` diff in range mode. If one commit in the range adds a forbidden path and a later commit deletes or renames it, the gate never reports it. A merge commit then carries that path into main's history, although AGENTS.md says such paths "must not appear in commits".
6. **Squash merges bypass `lint:pr`.** The repository allows squash and rebase merges. The maintainer decided (2026-11-24) to keep those settings, so this item is only recorded.
7. **`lint:pr` with base equal to head.** `scripts/check-pr-range.sh:15-22` handles `pnpm lint:pr X X` by printing commitlint's usage text instead of the fixed `unreadable range` reason.

## What Changes

- **#1 and #2.**
  - New script `scripts/pr-diff-lines.sh <from> <to>` (bash 3.2 and awk). It sums `git diff --numstat --diff-filter=ACMR --ignore-all-space <from>...<to> -- . ':(exclude)pnpm-lock.yaml' ':(exclude)schemas/openapi.json'`.
  - Binary files (`-\t-`) count as 0. Deleted files stay uncounted, as they are today.
  - The script **fails closed**. A wrong argument count, an unresolvable ref, or a failing `git diff` exits non-zero with a fixed reason and prints no count. It checks git's own exit status instead of relying on a pipe, because the default `run` shell has no `pipefail`.
  - The CI step calls the script with `HEAD^1 HEAD^2`, the merge ref's base tip and the PR head. It first requires `HEAD^2` to resolve. The payload's `base.sha` is no longer used for the count.
- **#3.**
  - The CI step writes `git diff -z --no-renames --name-only --end-of-options "$RANGE" --` to a temporary file and passes that file as `docs-only-diff.sh`'s stdin. It does not pipe. The PR range and push range share this line.
  - The classifier reads NUL-delimited paths (`read -r -d ''`), as #665 did for naming. An empty diff still gives `evidence required: empty diff`.
  - A NUL stream fed to the old line reader is **fail-open** on bash 3.2: git sorts paths, and `docs/a.md\0platform/x.ts\0z.md\0` (doc, code, doc in git's order) comes out as docs-only on both bash 3.2 and bash 5. So the evidence includes that three-path case.
- **#4.** `commitlint.config.cjs` gains one `ignores` entry, by maintainer decision (`## Decision (#4)`). It skips a message only when both hold:
  - its subject is exactly `build(deps): Bump …` or `build(deps-dev): Bump …`;
  - it carries the trailer line `Signed-off-by: dependabot[bot] <support@github.com>`.

  The same subject without the trailer, and any other message, is linted exactly as before. `.github/dependabot.yml` is unchanged.

- **#5.**
  - In range mode, `check-naming.sh` checks the **union** of two path sets:
    - the existing net diff (`base...head`, `--diff-filter=AR`);
    - every commit's own added or renamed paths: `git log -z --format= --name-only --diff-filter=AR --end-of-options "$base..$head" --`.
  - The union matters because `git log` prints no diff for a merge commit. Using `git log` alone would lose a path that only a merge adds, which the net diff catches today.
  - `--diff-merges=first-parent` is not used. A merge of main into the branch would re-list main's paths.
  - Staged mode and path mode are unchanged.
- **#6.** Recorded only; no change.
- **#7.** `check-pr-range.sh` rejects `base == head` as `lint:pr: unreadable range` (exit 2) before it calls commitlint.
- **Tests and docs.**
  - Each item gets a guardrail case in `scripts/test-guardrails.sh` that is red before the change and green after.
  - `scripts/README.md` documents the new script and the cases.
  - `constraints.yaml` `size_limits.max_pr_diff_lines.enforced_by` names the script.

## Decision (#4)

The maintainer first chose (session prompt, 2026-11-24; #715 has no comment) to fix #4 by configuring Dependabot's `commit-message`. The fixture review then found that this mechanism cannot work.

- Upstream `dependabot-core` `pr_name_prefixer.rb` `capitalize_first_word?` ignores an explicit prefix.
- It capitalises whenever the repository's last 100 non-bot commit messages all match `/:\s+\[?[A-Z]/`.
- Every commit here carries `Co-Authored-By: Claude …`, so every message matches, and the subject stays `Bump …`. This matches every past Dependabot title (#171–#612).

The maintainer then chose (session prompt, 2026-11-25) a narrow commitlint ignore keyed to Dependabot's subject shape and signed-off trailer. Anyone can write that trailer, so a spoofed commit could skip message lint only. Naming, diff size and every other gate still apply. That is the accepted cost.

## Triage

```text
Issue type: bugfix (CI gates)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: every PR's required gates (diff size, Docker-evidence exemption, PR range, naming); a wrong count or classifier blocks or wrongly passes PRs; workflow changes need explicit flagging
Selected risk packs: Public API / CLI / script entry; Config / project setup; File IO / path safety; Legacy compatibility; Error handling
Evidence floor: one red-before/green-after guardrail case per item; pnpm test:guardrails; pnpm lint:shell; pnpm lint:ci; pnpm lint; exact-head VPS lane (non-docs)
```

## Capabilities

### Modified Capabilities

- `pr-range-gates`:
  - Naming covers every path any commit in the range adds, merge commits included.
  - An equal base and head is unreadable.
  - New requirement: the diff-size gate counts exactly the PR's own lines and fails closed.
- `trusted-docker-verification`: the docs-only classifier receives NUL-delimited, byte-exact paths.

## Impact

- `.github/workflows/ci.yml` (**workflow change; the PR flags it**), `commitlint.config.cjs` (one narrow `ignores` entry)
- `scripts/pr-diff-lines.sh` (new), `scripts/docs-only-diff.sh`, `scripts/check-pr-range.sh`, `.git-hooks/check-naming.sh`, `constraints.yaml` (`enforced_by` text)
- `scripts/test-guardrails.sh`, `scripts/README.md`
- Reported, not changed: the docker-evidence `RANGE` and lockfile-consistency steps use the same stale `base.sha...HEAD` pattern.
