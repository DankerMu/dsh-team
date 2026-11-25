## Risk packs

- **Public API / CLI / script entry: selected.** `pnpm lint:pr` gains a new rejection, and `scripts/pr-diff-lines.sh` is a new entry. Tasks 1.1, 1.5, 2.1.
- **Config / project setup: selected.** Changes to `ci.yml` steps, `commitlint.config.cjs` and `constraints.yaml`. Tasks 1.1–1.3, 2.1.
- **File IO / path safety: selected.** NUL-delimited, byte-exact paths, including non-ASCII ones. Tasks 1.2, 1.4.
- **Legacy compatibility: selected.** Every existing guardrail case still passes. Deletions stay uncounted, and staged and path naming are unchanged. Task 2.1.
- **Error handling: selected.** Unreadable range, empty diff and classifier exit codes. Tasks 1.2, 1.5.
- **Not selected:** schema, auth, concurrency, resources, release and docs beyond `scripts/README.md`.

## Acceptance mapping (#715)

- Each item gets a guardrail mutant or unit case that is red before the change and green after: #1 lines starting with `-`, #2 a stale base, #3 a non-ASCII `.md`, #4 the real Dependabot message, #5 a path added then deleted within the range, #7 base equal to head. Tasks 1.1–1.5.
- The PR flags its `.github/workflows/` change (task 2.2).
- #6 is recorded as a maintainer decision (task 2.2).

## Must preserve

See design.md § Must preserve.

## 1. Implementation

Write each guardrail case first, run it against the unchanged code, and record its red output.

- [x] 1.1 #1/#2: add `scripts/pr-diff-lines.sh` (fail-closed) and change the CI step to `HEAD^1 HEAD^2`, requiring `HEAD^2`. Add the step-text cases in a merge fixture: exact count, stale base, non-merge `HEAD` fails, label `if:`. Add script cases: binary, wrong argument count, unresolvable ref. Update `constraints.yaml` `enforced_by`.
- [x] 1.2 #3: change the CI step to write `-z` output to a temporary file and pass it as stdin. Make `docs-only-diff.sh` read NUL-delimited input. Switch the `docs_only()` helper to NUL-delimited output. Add two `scope_case` cases: non-ASCII, and three paths in git order doc, code, doc (`docs/a.md`, `platform/x.ts`, `z.md`). Push mode in the same step must use the same input form.
- [x] 1.3 #4: add the narrow `ignores` entry to `commitlint.config.cjs`. Add guardrail cases: #612's real message accepted; the same subject without the trailer rejected; the trailer on a non-Dependabot subject rejected; a bad type rejected.
- [x] 1.4 #5: make range-mode naming check the union of the net diff and each commit's added and renamed paths. Add the add-then-delete, merge-then-delete, merge-then-rename and clean-sync-merge cases, and the merge-only-path case, and re-check every existing `range_*` case.
- [x] 1.5 #7: make `base == head` an unreadable range. Add the guardrail case.
- [x] 1.6 Document the new script and cases in `scripts/README.md`, and change its classifier input line (`:90`) to `git diff -z`.

## 2. Verification

- [x] 2.1 Record each new case red before its change and green after. Then run `pnpm test:guardrails`, `pnpm lint:shell`, `pnpm lint:ci`, `pnpm lint` and `pnpm fmt:check`. Also run `pnpm lint:pr origin/main HEAD` on the branch.
- [ ] 2.2 In the PR:
  - flag the `.github/workflows/` change;
  - record #6 as unchanged by maintainer decision;
  - list the stale sibling ranges as reported, not changed;
  - record #4's decision change and the upstream source behind it;
  - expect the new count to exceed 400 (it counts Markdown bullets the old grep skipped), so carry `diff-limit-exempt` with a justification.

  Run the exact-head trusted VPS lane (`pnpm test:docker` and `pnpm test:deploy`).
