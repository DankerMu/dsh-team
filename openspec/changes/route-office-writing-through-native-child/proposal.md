# Proposal

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (production Agent configuration and cross-Session evidence require expanded)
Blast radius: general writing route, writer identity/authority, existing model acceptance
Selected risk packs: Public API / CLI / script entry; Config / project setup; File IO / path safety / overwrite; Schema / columns / units / field names; Auth / permissions / secrets; Concurrency / shared state / ordering; Resource limits / large input / discovery; Legacy compatibility / examples; Error handling / rollback / partial outputs; Release / packaging / dependency compatibility; Documentation / migration notes
Evidence floor: unchanged genuine model task produces native writer contribution and readable DOCX; pnpm check, strict OpenSpec, exact-head full Docker/CI, expanded review and independent retirement

## Why

The real task17.4 run on `9c958ec` completed a notice under `office-general` with zero native delegation calls or children, despite producing a valid DOCX. The existing creation-time plugin correctly selects writer for an already-created child, but the production instructions do not explain that operational route and also direct the general Agent to follow authoring skills itself.

## What Changes

- Clarify the existing general persona and shared writing skill's role boundary: writing requests go through the native `subagent` tool and its self-contained task argument; the existing host plugin selects `office-writer`. Do not invent a preset argument, alter the human request or replace the provider.
- Remove the contradictory instruction that makes the general Agent start authoring before delegation. Preserve skill discovery, all current tools, ordinary file operations, manual writer behavior and parent verification/edits after child completion.
- Reuse the unmerged #89 real-model scenario, native lineage oracle and observer in place, rather than create another verifier. Following confirmed EVID-1 and explicit user approval, replace the insufficient artifact-materialization test with a writer-scoped structured DOCX construction operation and native execution-bound evidence. This proves construction, not independent content authorship; parent facts/drafts and later edits remain allowed, while copy-only delivery fails. Qualify released registration, permission, execution and result seams before implementation. A single atomic PR against main carries the production repair and acceptance changes; PR216 is superseded rather than stacked.
- Keep missing/failed delegation visibly unsuccessful. No parent-only fallback, hidden provider retry, private DSH hook or runtime tool stripping.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `office-agents`: extend the conditional native writer composition contract to require the general Agent to initiate that route for writing tasks, while preserving existing child identity, authority and lifecycle requirements.

## Impact

- Production: the canonical `plugins/office-agents/` bundle, its writer-scoped construction operation, persona/skill guidance and documentation, plus necessary user-image bundle delivery. Public rc.2 extension qualification is a prerequisite; no DSH source/version, provider or dependency change. Existing permission tiers and sandbox boundaries must apply to the new operation, not be bypassed by host-side spawning.
- Verification: update #89's current `platform/test/office-*` and managed-model path in place. Preserve actual native copy-only RED and positive child construction, permission/path/cancellation/error controls, all existing manual/other model cases and unchanged human task. Literal prompt snapshots and model claims are not proof.
- Expanded standalone fixture for #217, prerequisite to reconciling #89 and continuing Epic #3. Prior PR216 findings remain mandatory review inputs, not reset by branch migration.
- The user authorized a new bounded cycle of at most three diagnosis–repair–recheck attempts, with trusted giap-vps execution and independent authority/resource retirement. Human critical-path/rule review remains deferred to Epic completion.

## Non-goals

Deterministic semantic intent classification, independent content authorship certification, new routing tools, global tool removal, modified test prompts, retries until success, model/DSH upgrades, new office Agents and rendering. The explicitly revised contract permits supplied drafts but rejects copy-only materialization; no other acceptance gate is relaxed. Text guidance is not a mathematical guarantee of model compliance; a failed real task blocks delivery.
