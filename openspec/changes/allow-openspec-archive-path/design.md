# Design

## Context

The original staged archive commit failed with `scratchpad directory` for every OpenSpec artifact. Both path-argument and staged-index hook modes apply the same unconditional scratchpad regex, but duplicate the decision logic. The user authorized a narrow policy correction, not a hook bypass or removal of `archive` from the forbidden list. Archive work is parked separately at stash `9ff2b465e645218c29bd2fcd4640c76de8af5cde`.

## Goals / Non-Goals

Accept the standard managed archive component while preserving every other forbidden component/suffix and existing entrypoint status/diagnostic semantics. No alternate archive directory, extension/content inspection, real calendar validation, global archive exemption, CI change, product change or new dependency.

## Decisions

The existing constraints section owns one anchored standard archive path pattern. The existing lightweight extraction reads that field explicitly; absent configuration means no exception. The path must be root-relative, have a dated kebab-case change directory and a nonempty descendant, and contain no `.` or `..` path segments for the exception to apply.

One shared classification implementation serves both modes. For an eligible path, remove only the managed `archive` component from the scratchpad candidate, leaving the dated change and all descendants subject to the original scratchpad check. Forbidden-suffix matching always uses the original complete path. Never return success merely because a path is under the managed archive prefix. The staged scan must continue through every file and reject a mixed valid/invalid index.

Keep Bash3.2 compatibility and existing exit semantics: argument rejection2, staged rejection1, acceptance0, reason-bearing errors. Missing exception configuration retains the old strict behavior. Do not add a separate path-policy implementation in tests or a general exception framework.

## Must-preserve contract

Must preserve: global archive/scratch/backup and other current directory bans, forbidden suffixes, whole-index validation, diagnostics/status semantics, fallback behavior without constraints.
Must add/change: only the user-authorized standard archive component allowance in both entrypoints.
Governing invariant: an eligible OpenSpec archive exempts one directory component, never a descendant or another staged path.
Sibling surfaces: argument mode, staged-index scan, constraints parser/defaults, guardrail fixture lifecycle, AGENTS rule.
Seams under test: actual shell hook with literal paths and temporary Git indexes through existing guardrail self-test.
Required evidence: legal proposal/tasks/.openspec.yaml/nested spec paths accepted; ordinary/lookalike/non-dated archives, nested scratch/archive/backup, forbidden suffixes, dot-segment aliases and mixed indexes rejected. Preserve the original rejected archive as RED.
Non-goals: whether archived content is complete or semantically valid (OpenSpec validation owns it); runtime product behavior.
Review focus: exact component scope, shared entrypoint semantics, configuration parsing/fallback, no early index acceptance, meaningful negative controls.

## Risks / Trade-offs

A broad prefix bypass would silently permit forbidden descendants; residual path and original suffix checks prevent it. Root-relative matching intentionally does not add an absolute-path alias. Layout validation checks syntax, not calendar reality. Fixture copies must remain isolated and restored between staged scenarios.

## Migration / Verification

No data migration. Add failing acceptance regressions first; parent observes RED against the unchanged hook. Implement, then run actual hook smoke, shell lint and guardrails, followed by required local/CI gates. After policy merge, restore and separately publish the parked archive; the shared Epic fixture stays active.

## Open Questions

None: the user explicitly selected the narrow exception and continued rejection elsewhere.
