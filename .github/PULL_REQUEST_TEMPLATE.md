## Summary

<!-- One paragraph: what changed and why. -->

## Type of change

- [ ] feat — new functionality
- [ ] fix — bug fix
- [ ] refactor — internal change, no behavioural change
- [ ] chore — tooling, deps, infra
- [ ] docs — documentation only
- [ ] test — tests only

## Test plan

<!-- Specific commands and results. "I ran the tests" is not a test plan. -->

- [ ] Checks covering the changed surface pass (name the `pnpm` scripts run)
- [ ] New or changed tests were seen failing before the change
- [ ] Not tested: <state what was not verified, or "nothing">

## Runtime evidence

<!-- Required: commands run and key output; for UI changes a screenshot reference.
     State which branch was serving and whether data and keys were real or fixtures.
     Only accepted escape hatch, verbatim: "None — review-only change (reason: ...)". -->

## Risk

<!-- What could break, who is affected, how to roll back. -->

- [ ] Touches a critical path listed in `AGENTS.md` (`## Critical Paths`) — needs line-by-line human review
- [ ] Changes `.github/workflows/` or a gate script

## Canonicality check

- [ ] No `_v2`/`_new`/`_old`/`_backup` names, no commented-out code, no scratch directories
- [ ] If this replaces an implementation, the old one is deleted in this PR

## References

<!-- Issues, requirement ids (F…, D…, T…), task package -->
