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
- Reuse the unmerged #89 real-model scenario, native lineage/contribution oracle and qualified observer in place, rather than create another verifier. A single atomic PR against main carries the production repair and those necessary acceptance changes; PR216 is superseded rather than stacked.
- Keep missing/failed delegation visibly unsuccessful. No parent-only fallback, hidden provider retry, private DSH hook or runtime tool stripping.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `office-agents`: extend the conditional native writer composition contract to require the general Agent to initiate that route for writing tasks, while preserving existing child identity, authority and lifecycle requirements.

## Impact

- Production: `plugins/office-agents/cordis.patch.yml`, `skills/official-writing/SKILL.md` and the bundle's existing documentation. The public rc.2 persona/skill configuration is the intended mechanism; no DSH package, provider, dependency or permission change.
- Verification: reuse #89's current `platform/test/office-*` and managed-model path plus existing full native/Docker checks. Literal prompt snapshots are not behavioral proof; the original real-model failure is retained as RED and the unchanged real task must pass after repair.
- Expanded standalone fixture for #217, prerequisite to reconciling #89 and continuing Epic #3. Prior PR216 findings remain mandatory review inputs, not reset by branch migration.
- The user authorized a new bounded cycle of at most three diagnosis–repair–recheck attempts, with trusted giap-vps execution and independent authority/resource retirement. Human critical-path/rule review remains deferred to Epic completion.

## Non-goals

Deterministic semantic intent classification, new routing tools, global tool removal, modified test prompts, retries until success, model/DSH upgrades, new office Agents, rendering and relaxed acceptance. Text guidance is a supported production mechanism, not a mathematical guarantee of model compliance; a failed real task blocks delivery.
