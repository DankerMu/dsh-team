# Why

Issue #112: same-head PR opened/labeled deliveries share one concurrency group and cancel required checks. Actual failures were retained for PR110, PR187 and PR256 (run38871703832; distinct from run38871704167's missing-Docker-evidence failure). A green sibling run does not erase canceled required contexts.

# What Changes

- Give each pull-request workflow invocation an independent concurrency group, with no automatic PR cancellation. Preserve the current main-push group and no-cancellation policy.
- Preserve all trigger actions, label-sensitive gates, required check names, permissions and failure/cancel/skip rejection.
- Add an executable CI-concurrency policy gate and discriminating guardrail mutants; document full statusCheckRollup inspection.
- Accept the explicit issue alternative's tradeoff: superseded PR runs may finish, rather than leave false canceled checks. Action-only grouping is insufficient for repeated labeled deliveries; cancel=false alone still allows pending-run replacement in a shared group.

# Risk and Evidence

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; concurrency and protected CI policy require expanded
Blast radius: PR event scheduling and authoritative merge checks
Selected risk packs: Public script entry; Config; Concurrency; Error handling; Release compatibility; Documentation
Evidence floor: original real cancellation RED; parsed-workflow semantic gate RED/GREEN and mutants; actual same-head opened/label event completion; unchanged failure gates; full local checks/guardrails, independent review, exact-head Docker/CI

# Scope

Only CI concurrency, its verification entrypoint/guardrails and contributor guidance. No production behavior, branch-protection weakening, removed events, admin bypass, external model calls, new retry or relaxed timeout. Parent coupled fixture admission is disclosed rather than represented as independent review when higher single-slice delegation rules forbid a lone fixture reviewer.
