# Why

Issue #199 records a conflict between OpenSpec's standard archive destination and the repository's unconditional scratchpad-directory gate. The user explicitly authorized only a narrow OpenSpec archive exception, with positive and negative guardrail evidence; #179 and #76 are already merged and remain qualified.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: expanded (agree: shared CLI/index gate and path policy)
Blast radius: both naming-hook entrypoints and all staged paths
Selected risk packs: CLI, config, path safety, compatibility, error handling, documentation
Evidence floor: actual hook RED/GREEN in argument and staged modes; guardrail acceptance/rejection controls; shell lint, normal checks and existing protected-PR CI

# What Changes

- Keep the existing hook and constraints as the single naming-policy implementation/source.
- Permit only the standard root-relative `openspec/changes/archive/YYYY-MM-DD-<kebab-change>/<file>` archive component; retain all other scratchpad and forbidden-suffix rejection.
- Share classification across argument and staged-index entrypoints; document and test the authorized boundary.
- Land policy separately from the parked #179 archive. Do not bypass hooks, change CI or product behavior.

# Capabilities

## New Capabilities

- `canonicality-archive-policy`: narrowly scoped managed archive path acceptance with unchanged surrounding guards.

## Modified Capabilities

None.

# Impact

`.git-hooks/check-naming.sh`, `constraints.yaml`, `scripts/test-guardrails.sh`, and the existing AGENTS canonicality rule. No dependencies, runtime APIs, database, Docker behavior or unrelated naming-policy changes.
