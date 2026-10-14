# Design

## Context

See proposal.md for the observed no-child failure and scope. Fixture level: expanded; production model behavior plus high-risk evidence attribution. The user authorized #217 as the blocker before #89 with a new maximum-three-cycle diagnosis–repair–recheck allowance.

Two independent read-only investigations inspected pinned rc.2 artifacts. The native `subagent` schema accepts `description`, `prompt` and optional `run_in_background`, not a preset identifier. Its spawn provider has a separate context, so the task must be self-contained. The office host plugin already selects writer before the eligible child's first turn.

The public `dsh-persona` row registers a scoped prefix and suffix; `complete` defaults false and runtime context remains enabled. Skill discovery adds a separate user-kind catalog telling the model to load matching skills and follow them; loading a skill returns its instructions as a tool result. The current general prefix and shared writing skill both direct the parent toward authoring. These source-level ambiguities are observed; the failed run retained only bounded tool counts, so the exact loaded-skill sequence is not claimed.

No released task-intent state or tool-choice option was found. The public pre-step waterfall can rewrite input, and tool restrictions can remove capabilities, but neither supplies semantic task classification. Using them would invent a broader routing mechanism without evidence that it is necessary.

Primary sources: pinned `dsh-persona` rc.2 `lib/index.js`; `dsh-tool-subagent` rc.2 `lib/index.js` providerWording/parameters; `dsh-tool-skill` rc.2 catalog/rendering; `dsh-agent-loop` rc.2 pre-step/request sequence. Full reports live in `.run/issue217/{prompt-research,hook-research}.json`.

## Goals / Non-Goals

Goals: operationally coherent production instructions through the existing public composition seam; actual native writer contribution on the unchanged real notice task; preserve direct simple file work, parent verification, manual writer and all permission behavior.

Non-goals: deterministic semantic classifier, request rewriting, extra routing tools, private hooks, suppressed errors, parent-only fallback, tool stripping, provider/model changes or a new verification implementation.

## Decisions

1. **Repair guidance at its owner.** Keep the general persona's concise role and environment facts, then make its routing policy explicit: writing work starts a native child, the deployment selects writer, and the prompt includes the complete task/materials/output path because spawn has no inherited conversation. Do not suggest a nonexistent preset argument. The policy distinguishes drafting/revision from ordinary file manipulation and post-child checking; it does not use task complexity as an exception.
2. **Make the shared writing skill role-aware.** Before its authoring checklist, distinguish general coordination from writer execution. General delegates the substantive writing; writer follows the existing checklist. Reading skills is not forbidden, but loading an authoring skill must not silently convert general into writer. Keep official office skills, tools and existing registered names intact. Do not install a second skill/provider or modify upstream skill bytes.
3. **Preserve native state and authority.** Leave `plugins/office-agents/index.js`, native spawn, one-shot/background defaults, preset-selection events, immutable headers, permission inheritance and cancellation untouched. No runtime feature is disabled to coerce the model.
4. **Reuse acceptance atomically.** The independent #217 branch fast-forwards the seven unmerged #89 commits unchanged. The new PR targets main and supersedes PR216; this is not a dependent PR chain. Existing negative controls, pending-descriptor handling, synchronous child-end parser, process-quiescence guard and all older model cases remain canonical. Prior confirmed review findings carry forward as mandatory closure inputs.
5. **Use behavioral evidence, not wording tests.** The retained actual no-child run is the pre-change RED. Existing deterministic tests qualify the oracle and native extension contract, not the model decision. Native Docker execution checks composition/tool/permission/lifecycle preservation; the unchanged genuine model task is the routing acceptance. Do not add assertions on literal persona/skill wording or rerun the known failure merely to reproduce it.
6. **Bound iteration.** Record each new production candidate and outcome. No unchanged-head retry following failure. A new failure must retain bounded native facts and have a discriminating diagnosis before a repair; after three cycles stop. No provider invocation outside the trusted SHA-bound channel, and independent credential/resource retirement is mandatory on both outcomes.

## Verification and review contract

- Before edits: strict fixture validation and parent-inline fixture admission under the higher-priority single-mapped-slice delegation restriction. The two independent research leaves do not count as fixture/code reviewers.
- After edits: `pnpm check`, strict standalone/shared OpenSpec, actual native office Docker case and required complete Docker suite on giap-vps. The actual process regression must still accept settled preparation and reject a surviving parent writer.
- Real model: same human notice under fresh default general; exact native call/catalog/lineage, writer selection before work, task-bound child contribution and independently parsed final DOCX; preserved manual writer and every #82/#84/#85 case. No explicit delegation instruction added to the human task.
- Three independent expanded seats on isolated worktrees: correctness/invariants, test-evidence/spec compliance, security/lifecycle. Re-adjudicate PR216's P1 contribution and P2 descriptor findings against the combined diff. Final exact-head model/full Docker/CI plus inspected screenshots and independent retirement gate the protected merge.
- Tool/skill availability and direct file-task capability are preservation surfaces, not incidental defaults. The existing exact-byte general task and native scope/tier tests remain intact. Failed real-model evidence is not replaced by deterministic adapter success.

## Risks / Trade-offs

- Model compliance is probabilistic → this guidance repair is intentionally smaller than inventing semantic classification; real no-child output still fails, and a passing run is not claimed as a universal guarantee.
- Skill instructions can compete with persona policy → remove contradictory local role guidance in both owned surfaces; do not rewrite upstream or user content.
- Existing employee volumes retain delivered plugin bytes → this change qualifies fresh images/instances, following the current bundle delivery contract. No destructive migration of employee profiles is introduced.
- Combined diff includes substantial reused verification → justify atomicity through diff-limit-exempt, retain its history/negative controls and review the complete diff rather than only the new YAML.
- A native tool result need not prove process quiescence → retain #89's fail-closed attribution observer and real-process counterexample; no weaker job-status substitution.

## Migration Plan

No platform schema, HTTP contract or user-data migration. Build the user image with the canonical office bundle sources; fresh profiles receive the corrected persona/skill. Rollback reverts the bundle instruction change and rebuilds the image, without editing DSH or deleting employee data. Archive only this standalone change after protected merge; the shared Epic change stays open until all remaining DAG work and acceptance are complete.
