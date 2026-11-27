## Risk packs

- **Resource limits (selected).** The step duration on slow runners compared with the job limit. Task 1.1.
- **Release / CI workflow (selected).** A change under `.github/workflows/`. The PR flags it, and `pnpm lint` includes `lint:ci`. Task 2.1.
- **Not selected:** concurrency, file IO, error handling, public API, config, secrets, docs, legacy compatibility. This change edits one value and its comment.

## Must preserve

- Every guardrail case, `scripts/test-guardrails.sh`, every other job and its timeout, `All checks passed`, and branch protection.
- No gate is skipped or weakened, and a cancelled run is never treated as success.

## 1. Implementation

- [x] 1.1 Measure the fixed sample: the most recent N ≥ 30 consecutive CI runs whose guardrails job reached the step, main and PR runs together, excluding in-progress runs and skipped jobs. Read every attempt read-only through `gh api …/runs/<id>/attempts/<n>/jobs`; if attempts cannot be read, report the cancellation count as a lower bound. For each run take the step duration and the job overhead, and count cancellations. A cancelled job's step counts as at least its elapsed step time. Record the window, the sample size, the median, p90 and max, the max overhead and the number of cancellations in the PR description.
- [x] 1.2 Set `timeout-minutes` by the fit rule in the proposal: ⌈(1.5 × S + O) / 60⌉, and never less than 15. Put the basis in a comment above the line.

## 2. Verification

- [x] 2.1 `pnpm lint` (includes `lint:ci`) and `pnpm lint:agents` exit 0. Check prettier on `ci.yml`.
- [x] 2.2 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`, as the docker-evidence gate requires for a non-docs change.
- [x] 2.3 After merge, a comment on #747 records at least 30 subsequent runs, every attempt included, with no guardrails cancellation, and shows the slowest job ended at least 2 minutes under the limit. The PR uses `Refs #747`, never `Closes` or `Fixes`, so the merge does not close the issue. This task stays unchecked at merge. Closed on 2026-11-27 by the maintainer's decision after 13 post-merge runs (every attempt read): 0 guardrails cancellations, slowest job 608 s, 5:52 under the 16-minute limit; the maintainer waived the remaining 17 runs. If the post-merge sample shows a cancellation, or a job less than 2 minutes under the limit, the issue stays open and the work returns to re-measuring and re-fitting the limit.

## Acceptance mapping (#747)

- Measurement basis in the PR (at least 30 runs, window, median, p90, max, overhead): task 1.1.
- At least 30 post-merge runs without a cancellation, and the slowest at least 2 minutes under the limit: task 2.3, open after merge, with the issue referenced by `Refs #747`.
- Alternative A or B: not chosen, so not applicable.
- The PR flags the `.github/workflows/` change: the proposal and the PR Risk section.
