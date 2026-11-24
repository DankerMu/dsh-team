# PR range gates for commit messages and names

## Why

Issue #665. All line numbers below refer to main `c06faa3`.

Two gates are marked `block`, but they run only in local hooks and have no CI layer:

- `check-naming` (AGENTS.md Enforcement Index `:292`);
- commitlint (`:293`).

They are wired only through `.husky/pre-commit` and `.husky/commit-msg`. The CI workflow never invokes either one, and `pnpm test:guardrails` only proves that they would reject bad input if called. It never runs them against a PR.

A commit made with `core.hooksPath=.git-hooks` skips both checks silently. That directory holds only `check-naming.sh`, with no `pre-commit` or `commit-msg` hook, so git finds nothing to run and reports nothing. The same happens with `--no-verify`, in a fresh clone before `pnpm install`, or when committing through a web UI.

Since `2904e25`, 120 commit messages that violate commitlint have reached `main`. The issue measured this at `be168db`:

- 120 × `subject-max-length`
- 74 × `header-max-length`
- 7 × `footer-leading-blank`, which is only a warning

History is protected, so these commits stay as they are. Naming has not been violated, but it is exposed in the same way. AGENTS.md `:321` says CI is the authoritative layer, which is false for these two gates.

## What Changes

- **A single root script, `lint:pr`.** It takes a base and a head (`pnpm lint:pr <base> <head>`) and runs `scripts/check-pr-range.sh`, which does two things:
  - `pnpm exec commitlint --from <base> --to <head>`. commitlint 21 walks `git log base..head`. Its default ignores still skip merge commits, `fixup!`/`squash!`/`amend!`, `Revert`/`Reapply` and semver-only chores, the same as the hook. PRs land by merge commit, so the PR's own commits are what reach `main`.
  - It runs every added or renamed path in `git diff --name-only --diff-filter=AR <base>...<head>` through `check-naming.sh`, using a new range mode (`--range <base> <head>`). The range mode shares the existing classifier, so the #199 archive exemption carries over unchanged.

  Before either check runs, the script requires exactly two arguments, that each SHA passes `git rev-parse --verify --quiet "$x^{commit}"`, and that `git merge-base` succeeds. Otherwise it exits nonzero with the fixed reason `lint:pr: unreadable range`. The `--range` mode checks the status of its own `git diff` and never uses `|| true`.

- **A new CI job, `pr-range`.** It joins the `all-checks-passed` aggregator, so branch protection needs no change. It checks out with `fetch-depth: 0` and, on `pull_request` events, runs `pnpm lint:pr "$BASE_SHA" "$HEAD_SHA"` from `github.event.pull_request.base.sha` and `github.event.pull_request.head.sha`. It uses the PR head, not the synthetic merge checkout.
  - On `push` events the step is skipped. The job still succeeds, so history after `2904e25` can never fail a push to `main`.
  - The existing PR-only jobs (lockfile, diff size) live outside the aggregator because a skipped job would read as passing. This job stays inside the aggregator and is never skipped: only its step is conditional.
- **Guardrails.** `scripts/test-guardrails.sh` gains `expect_reject` and `expect_accept` cases for `pnpm lint:pr` on temporary ranges:
  - reject: a range whose commit has an overlong subject;
  - reject: a range that adds a `_v2` file;
  - reject: a range that adds a `tmp/` path;
  - reject: an unreadable range;
  - accept: a range whose base already holds an overlong-subject commit and a forbidden path, where the range itself modifies that path (M, not A/R), adds a default-ignored merge commit, and otherwise conforms;
  - accept: a range that adds a valid `openspec/changes/archive/YYYY-MM-DD-<change>/` file.
- **Documentation stops implying that `.git-hooks/` is a hooks directory.**
  - AGENTS.md Enforcement Index `:292-293` names `.husky/pre-commit` (which calls `.git-hooks/check-naming.sh`) and `.husky/commit-msg`, plus `pnpm lint:pr` in CI.
  - Local setup states that husky's `prepare` sets `core.hooksPath` to `.husky/_` and that it must not be overridden.
  - Known blind spots `:321` now says both gates have a CI layer over the PR range.
  - `scripts/README.md:11,15,16,20`, the `check-naming.sh` header, and `constraints.yaml:79,84,167` (`enforced_by`) are updated to match.
  - The Daily commands "CI gates" line lists `pnpm lint:pr <base> <head>`.

## Triage

```text
Issue type: bugfix (missing CI gate)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: every PR's required check; a wrong range (merge commit, base drift, or main history) would red every PR or every push; AGENTS.md and workflow changes need human review
Selected risk packs: Config / project setup (CI workflow, constraints enforced_by); Public API / CLI / script entry (new root lint:pr; new --range mode on the shared check-naming.sh); Error handling / rollback / partial outputs (fail-closed unreadable range); Documentation / migration notes (AGENTS.md, scripts/README, spec text for a third entrypoint)
Evidence floor: guardrail expect_reject/expect_accept for both gates through lint:pr; pnpm lint incl. lint:ci, lint:agents, lint:shell; pnpm test:guardrails; this PR's own CI run shows pr-range green on its range; a deliberate local negative run on a range with a bad commit; exact-head VPS lane (repository gate)
```

## Capabilities

### New Capabilities

- `pr-range-gates`: commit messages and new paths are gated over the PR range in CI.

### Modified Capabilities

- `canonicality-archive-policy`: the commit-range mode becomes a third naming entrypoint that shares the classifier.

## Impact

- `.github/workflows/ci.yml`: a workflow change, which this PR flags.
- `AGENTS.md`: needs human review before merge.
- `package.json`, plus a new `scripts/check-pr-range.sh`.
- `.git-hooks/check-naming.sh` (range mode).
- `scripts/test-guardrails.sh`, `scripts/README.md` and `constraints.yaml`.
- Open PRs that already contain non-conforming commits will go red after merge. They need a reword or a rebase.
