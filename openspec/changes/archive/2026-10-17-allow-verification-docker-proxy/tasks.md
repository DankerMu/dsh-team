# Tasks

## 1. Contract and proxy custody

- [x] 1.1 Validate the expanded fixture with `openspec validate allow-verification-docker-proxy --strict --no-interactive`; retain fixture review and disclosed inline-workflow deviation.
- [x] 1.2 Add a process/network regression at the existing Docker subprocess boundary; observe RED for lost proxy routing before changing the environment policy.
- [x] 1.3 Implement one canonical three-input projection across Docker clients and the acquisition producer; prove proxy routing, bypass, absent/empty inputs and excluded credentials using targeted integration checks.
- [x] 1.4 Keep actual browsers and employee containers free of injected proxies; prove native process exclusion and real isolated-container inspection. Update existing verification guidance with the client/daemon distinction and verification-only input scope.
- [x] 1.5 Apply the user-approved ordinary Debian mirror change only in `images/browser-verification`; retain the official security stanza, signed metadata/keyring, suites, package list, base digest and600s deadline. The real pre-change apt timeout is RED; delivered-image build and original full Docker are GREEN. Update existing verification guidance.
- [x] 1.6 Apply the later user-approved user-image extension through one build-only helper shared with the browser image; migrate all named-context builders/examples atomically. Prove real-file preservation and missing/duplicate/comment-only rejection, unchanged user-image version/DOCX/profile/runtime consumers and critical-path review before original full acceptance.

## 2. Packaging and acceptance

- [x] 2.1 Update every standalone image/rescue dependency bundle and prove module loading without repository imports; preserve cleanup/error semantics through existing focused regressions.
- [x] 2.2 Run `pnpm check:fast`, relevant `pnpm test:integration` cases and original full `pnpm test:docker` on the frozen reviewed head; retain independent resource and host/workload preservation evidence, cross-review and required CI before merge.
- [x] 2.3 Merge and archive #267 through protected PRs; restore PR264's saved review history and resume #176 without resetting its two used fix passes.

## Risk pack mapping

Selected: CLI/script entry and config → 1.2–1.3/1.6; secrets → 1.3–1.4; compatibility and error/cleanup → 2.1–2.2; packaging and build-time source rewrite → 1.5–1.6/2.1; file IO/preservation → 1.6; documentation → 1.4–1.6.
Not selected: schema/units (no persisted platform format change); concurrency/shared state (no policy change); resource limits/discovery (existing bounds unchanged).

Workflow deviation: parent performs mapped single-slice implementation and fixture review inline because developer delegation rules prohibit outsourcing one already-mapped slice. Independent cross-review remains multi-seat; agents do not run tests or modify the checkout.

Scope extension: user explicitly chose verification-image Debian source adjustment after the existing proxy-exit experiment failed and was restored. No new permanent source-text/default-copy test is added for the mirror URL; the unchanged real build/consumer gate is the behavioral oracle. Re-review the source/trust boundary before trusted execution.

Later explicit scope extension: user approved the same ordinary source change for the production user-image build after its unchanged apt step failed independently. Preserve official security source/signatures/current base reference/DSH version/packages/deadlines and no runtime proxy injection. Base-digest follow-up#273 and remote-runner follow-up#274 are not implemented here.

Completion evidence: PR268 merged reviewed/human-approved `a17fbf68dff90e96bcd8b97ba7b58eb7ec366638` as `f954aa5cbec26045c6ae64a66937e8e5ff1d6258`. Focused integration69/69, user-image4/4, standalone Compose11/11 and original full Docker91/91 passed; independent cleanup/host preservation passed. Both CI39047050024 and CI39047347366 are green. Durable evidence: https://github.com/DankerMu/dsh-team/pull/268#issuecomment-6244306553 .

Task2.3 handoff completed after archive PR275 merged as `ff9b2bdd3ced438fa565dec7c414780492d1ee7f`: its exact head passed standalone Compose11/11, original full Docker91/91 and required CI39087525965. PR264's saved four-round ledger was restored verbatim with both used fix passes retained, and its branch rebased onto that merged main without conflicts. #176 runtime acceptance remains a separate task; it is not claimed by this handoff.
