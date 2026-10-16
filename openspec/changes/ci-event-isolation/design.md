# Design

Change surface: `.github/workflows/ci.yml` workflow-level concurrency; root lint command, scoped policy checker and `scripts/test-guardrails.sh`; AGENTS contributor guidance/enforcement inventory.

Must preserve: opened/synchronize/reopened/labeled/unlabeled subscription; main push subscription and its existing group/no-cancel semantics; event-snapshot labels; diff-size/lockfile checks; aggregate failure on failure/cancelled/skipped; Docker attestation; read-only token permissions and branch protection.

Must change: every PR invocation uses its own GitHub run ID group, so even repeated same-action labels cannot replace a pending sibling or cancel a running one. No PR automatic cancellation is retained. This is the issue's safe no-cancel alternative with pending-queue collisions removed; added runner usage is explicit.

Governing invariant: a new PR delivery must not cancel a same-head sibling's required checks; genuine failing checks still block acceptance.

Sibling surfaces: workflow group/cancel expressions, label-sensitive gate conditions, required-status aggregation, normal PR/main triggers, reruns and branch protection observations.

## Evidence Design

- Preserve actual historical RED (PR256 run38871703832 cancelled dependencies/failed aggregate) without rerunning merely to confirm it. Do not confuse its sibling missing-attestation failure.
- The lint gate parses actual YAML and evaluates actual expressions with GitHub's expression implementation, not a second handwritten evaluator or string-pinned expected source. Pinned build-only YAML parser reuses the version already in the lockfile; pinned @actions/expressions provides expression semantics.
- Evaluate multiple same-ref/same-head opened, repeated labeled, unlabeled, reopened and synchronize deliveries with distinct run IDs. Groups must not collide (case-insensitive), regardless of cancel=false because pending replacement remains possible.
- Main contexts with distinct run IDs must retain shared ref grouping and cancel=false. Invalid/nonstring groups, unknown expressions and invalid cancellation values fail closed.
- Known-bad controls: old ref-only policy; ref-only with cancel=false; action-only groups with repeated labels; malformed expression. Restore the real candidate after each disposable mutation. Preserve full guardrail suite, including known Bash3.2 issue201 without fixing it here.
- Real Actions on the reviewed PR head: create with a justified temporary exemption label, then remove it on that same head. Record event/run identities, full check rollups and job/step outcomes; opened/labeled/unlabeled must settle without automatic cancellation. Final no-exemption gate must run normally; code failure continues to fail aggregate. Read actual workflow revision used by the PR before accepting this evidence.

Non-goals: general YAML/Actions workflow framework, production changes, branch protection edits, redesigning all CI jobs, force-pushing shared branches, all possible future expressions, external model work, changing label policy or hiding stale failures.

Rollback: revert concurrency/gate/docs together. No runtime migration or data changes.

## Primary Sources

- GitHub concurrency: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency — shared groups can replace pending runs even with cancel-in-progress=false.
- GitHub contexts: https://docs.github.com/en/enterprise-cloud%40latest/actions/reference/workflows-and-actions/contexts — run_id is per workflow invocation; run_attempt changes on rerun.

Review focus: no same-head cancellation/queued eviction, label authority preserved, gate mutants reject semantically rather than on setup, no widened permissions or weakened merge gate, main semantics unchanged.
