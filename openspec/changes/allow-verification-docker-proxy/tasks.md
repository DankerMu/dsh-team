# Tasks

## 1. Contract and proxy custody

- [x] 1.1 Validate the expanded fixture with `openspec validate allow-verification-docker-proxy --strict --no-interactive`; retain fixture review and disclosed inline-workflow deviation.
- [x] 1.2 Add a process/network regression at the existing Docker subprocess boundary; observe RED for lost proxy routing before changing the environment policy.
- [x] 1.3 Implement one canonical three-input projection across Docker clients and the acquisition producer; prove proxy routing, bypass, absent/empty inputs and excluded credentials using targeted integration checks.
- [ ] 1.4 Keep actual browsers and employee containers free of injected proxies; prove native process exclusion and real isolated-container inspection. Update existing verification guidance with the client/daemon distinction and verification-only input scope.

## 2. Packaging and acceptance

- [ ] 2.1 Update every standalone image/rescue dependency bundle and prove module loading without repository imports; preserve cleanup/error semantics through existing focused regressions.
- [ ] 2.2 Run `pnpm check:fast`, relevant `pnpm test:integration` cases and original full `pnpm test:docker` on the frozen reviewed head; retain independent resource and host/workload preservation evidence, cross-review and required CI before merge.
- [ ] 2.3 Merge and archive #267 through protected PRs; restore PR264's saved review history and resume #176 without resetting its two used fix passes.

## Risk pack mapping

Selected: CLI/script entry and config → 1.2–1.3; secrets → 1.3–1.4; compatibility and error/cleanup → 2.1–2.2; packaging → 2.1; documentation → 1.4.
Not selected: schema/units (no persistent format change); file overwrite (no new runtime writer); concurrency/shared state (no policy change); resource limits/discovery (existing bounds unchanged).

Workflow deviation: parent performs mapped single-slice implementation and fixture review inline because developer delegation rules prohibit outsourcing one already-mapped slice. Independent cross-review remains multi-seat; agents do not run tests or modify the checkout.
