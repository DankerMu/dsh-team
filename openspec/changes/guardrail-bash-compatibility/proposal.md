# Why

Issue201 records Bash3.2 parsing failure in the duplicate canary's Node heredoc nested inside command substitution. The historical RED is accepted without rerunning it just to confirm. A minimal five-line literal heredoc isolates the same unmatched-apostrophe EOF under3.2; Bash5 accepts it. Balancing the apostrophe or moving the heredoc outside substitution passes; removing outer assignment quotes does not.

# What Changes

Move only the count-producing heredoc out of command substitution, redirect its unchanged output to a file beneath the existing owned temporary root, then read the count with a shell builtin. Preserve the Node program bytes, dynamic corpus/threshold arithmetic, all guardrail cases, default macOS shell support and existing cleanup.

# Risk and Evidence

Issue type: bugfix
Fixture level: compact
Upstream suggested level: absent; isolated shell grammar repair, no changed gate or public exit contract.
Selected risk packs: compatibility; error/cleanup; gate evidence integrity.
Evidence floor: minimized3.2 RED/5GREEN controls, candidate syntax on both shells, full root pnpm test:guardrails on both actual interpreters with equal cases/canary sizes, no fixtures/worktrees/process residue, shell lint/check-fast and required CI/Docker evidence.

# Scope

No archive-policy, naming-hook, threshold, dependency or other script changes. Do not merely remove the apostrophe or require newer Bash. Parent inline mapped work follows higher single-slice delegation restrictions; independent code/evidence and gate-integrity review before merge.
