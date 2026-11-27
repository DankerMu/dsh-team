# The guardrails job's time limit has a measured margin

## Why

Issue #747. Line numbers refer to main `71cf68d`.

- **The limit.** The required `guardrails` job (`.github/workflows/ci.yml:214`) has `timeout-minutes: 10`. That value has not changed since the initial skeleton (`76070ce`). Since then `scripts/test-guardrails.sh` has had 28 commits (`git log 76070ce..71cf68d`).
- **The sample.** The issue sampled 59 CI runs between 2026-11-25 04:02 and 2026-11-26 05:30 UTC. The `pnpm test:guardrails` step took:
  - median 6:26;
  - p90 8:33;
  - at most 9:39 among completed runs;
  - at least 9:57 in one main run that was killed.
- **Job overhead.** It adds 16–34 s.
- **Cancellations.** In that sample, 2 of 59 jobs were cancelled at 10m0s, one of them on `main`. One of those had already printed `190 passed, 0 failed`.
- **Cause.** A slow run is about 1.45× slower in every case class, and runs on the same head vary by about 3 minutes. This points to runner speed, not to any one case.
- **Why it matters.** AGENTS.md forbids treating a cancelled check as success. Every such cancellation therefore costs a manual rerun and delays merges.

## What Changes

The issue's recommended option.

- **Fresh measurement.** The sample is fixed in advance: the most recent N ≥ 30 consecutive CI runs whose guardrails job reached the `pnpm test:guardrails` step. Runs still in progress and skipped jobs are excluded. Main and PR runs both count. The data is read-only through `gh`.
  - The step's duration is its `completedAt − startedAt`, and the job overhead is the job's total duration minus the step's.
  - Every attempt of each run is read, through `gh api repos/{owner}/{repo}/actions/runs/<id>/attempts/<n>/jobs`, so a job that was cancelled and then rerun is still counted. If the attempts cannot be read, the cancellation count is reported as a lower bound.
  - The record goes in the PR description, and the `ci.yml` comment summarises it.
  - Record the sampling window, the sample size, the step's median, p90 and maximum, the maximum job overhead, and the number of cancelled jobs.
  - A cancelled job's step counts as at least its elapsed step time (`completedAt − startedAt` of the step), and is not used as a completed value.
- **Fit rule.** Let `S` be the larger of the measured step maximum and the lower bound of any cancelled job, and let `O` be the maximum job overhead.
  - `timeout-minutes` = ⌈(1.5 × S + O) / 60⌉, the smallest whole number of minutes at or above that figure.
  - If that comes out below 15, use 15. The issue derives 15 from its own data: the slow runner's 1.5× factor applied to the 6:26 median gives about 9:40, plus room for case growth.
  - The 1.5 in the rule is a separate headroom factor for case growth. It leaves well over the 2 minutes of margin that the issue's acceptance requires for the slowest observed job.
- **Basis comment.** A comment above the line states the window, sample size, median, p90, maximum, overhead and the rule.
- **Unchanged:**
  - every guardrail case and gate;
  - every other job, including its timeout;
  - `All checks passed` and branch protection.

`design.md` is omitted at the compact level: the change is one workflow value and its comment. The change touches `.github/workflows/`, so the PR says so (AGENTS.md).

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent (override: none upstream; compact because the change is one CI timeout value and its comment)
Blast radius: the required guardrails job's time limit; no gate's behavior
Selected risk packs: Resource limits (CI time budget); Release / CI workflow
Evidence floor: measurement record (>= 30 runs); pnpm lint (includes lint:ci); post-merge observation of >= 30 runs without a guardrails cancellation (tracked on the issue)
```

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `guardrail-verification`: the guardrail self-test job's time limit states a measured basis.

## Impact

- `.github/workflows/ci.yml`: the `guardrails` job's `timeout-minutes` and its comment.
