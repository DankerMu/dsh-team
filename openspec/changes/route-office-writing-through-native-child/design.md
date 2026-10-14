# Design

## Context

See proposal.md for the observed no-child failure and scope. Fixture level: expanded; production model behavior plus high-risk evidence attribution. The user authorized #217 as the blocker before #89 with a new maximum-three-cycle diagnosis–repair–recheck allowance.

Two independent read-only investigations inspected pinned rc.2 artifacts. The native `subagent` schema accepts `description`, `prompt` and optional `run_in_background`, not a preset identifier. Its spawn provider has a separate context, so the task must be self-contained. The office host plugin already selects writer before the eligible child's first turn.

The public `dsh-persona` row registers a scoped prefix and suffix; `complete` defaults false and runtime context remains enabled. Skill discovery adds a separate user-kind catalog telling the model to load matching skills and follow them; loading a skill returns its instructions as a tool result. The current general prefix and shared writing skill both direct the parent toward authoring. These source-level ambiguities are observed; the failed run retained only bounded tool counts, so the exact loaded-skill sequence is not claimed.

No released task-intent state or tool-choice option was found. The public pre-step waterfall can rewrite input, and tool restrictions can remove capabilities, but neither supplies semantic task classification. Using them would invent a broader routing mechanism without evidence that it is necessary.

Primary sources: pinned `dsh-persona` rc.2 `lib/index.js`; `dsh-tool-subagent` rc.2 `lib/index.js` providerWording/parameters; `dsh-tool-skill` rc.2 catalog/rendering; `dsh-agent-loop` rc.2 pre-step/request sequence. Full reports live in `.run/issue217/{prompt-research,hook-research}.json`.

## Goals / Non-Goals

Goals: operationally coherent production instructions; a genuine native writer executing structured DOCX construction on the unchanged real notice task; preserve direct simple file work, parent-provided facts/drafts, later verification/edits, manual writer and all permission behavior. Following confirmed EVID-1, the user explicitly approved this observable construction contract instead of independent substantive-content attribution.

Non-goals: independent content authorship certification, deterministic semantic classifier, request rewriting, extra routing tools, private hooks, suppressed errors, parent-only fallback, tool stripping, provider/model changes or a second verification implementation.

## Decisions

1. **Repair guidance at its owner.** Keep the general persona's concise role and environment facts, then make its routing policy explicit: writing work starts a native child, the deployment selects writer, and the prompt includes the complete task/materials/output path because spawn has no inherited conversation. Do not suggest a nonexistent preset argument. The policy distinguishes drafting/revision from ordinary file manipulation and post-child checking; it does not use task complexity as an exception.
2. **Make the shared writing skill role-aware.** General coordinates and delegates; writer follows the existing checklist and constructs DOCX through the production operation. Supplied textual drafts are allowed under the revised contract. Keep official skill discovery and existing tools; do not rewrite upstream skill bytes.
3. **Preserve native state and authority.** Keep native spawn, one-shot/background defaults, preset-selection events, immutable headers, permission inheritance and cancellation. Register construction only in the writer scope through qualified public rc.2 APIs. Its structured text/destination input must not expose arbitrary commands, scripts, source-DOCX passthrough or opaque document bytes. Reuse the existing Python/python-docx environment and native workspace execution boundary; direct host execution cannot bypass native permission or sandbox controls.
4. **Reuse acceptance atomically.** The independent #217 branch carries the seven unmerged #89 commits; PR218 targets main and supersedes PR216. Preserve lineage/readiness and actual copy-only counterexample. Migrate the canonical oracle to successful native construction results bound to the selected child's relevant turn, call and requested path, plus artifact observation before parent resumes. Model text and workspace-written receipt files are not authority. Earlier process/absence heuristics alone are not construction evidence; retain lifecycle controls where still relevant rather than treating them as authorship proof.
5. **Use behavioral evidence, not wording tests.** The retained actual no-child run is the pre-change RED. Existing deterministic tests qualify the oracle and native extension contract, not the model decision. Native Docker execution checks composition/tool/permission/lifecycle preservation; the unchanged genuine model task is the routing acceptance. Do not add assertions on literal persona/skill wording or rerun the known failure merely to reproduce it.
6. **Bound iteration.** Record each new production candidate and outcome. No unchanged-head retry following failure. A new failure must retain bounded native facts and have a discriminating diagnosis before a repair; after three cycles stop. No provider invocation outside the trusted SHA-bound channel, and independent credential/resource retirement is mandatory on both outcomes.
7. **Qualify before implementing the receipt.** Inspect pinned tool registration, validation, scoped visibility, permission/approval, cancellation, subprocess and result-event APIs; then exercise the smallest operation in actual native Docker without a real provider. Only successful actual construction may supply destination/digest metadata. Reject stale, sibling, parent-only, failed, cancelled, wrong-target and copy-only evidence. A child constructed artifact followed by parent edits remains valid even when final bytes differ. A supplied complete textual draft is valid input, but independent authorship is not claimed.

### Structured construction interface and qualification

The writer-only operation is `build_docx`, supplied by the canonical office bundle's `docx-construction` module. Inputs are a workspace destination and ordered `{text, style?}` paragraphs (`title`, `heading1`, `heading2`, `normal`), not notice-specific fields, existing document bytes or arbitrary code. Input/output are bounded. Destination creation is explicit and non-overwriting: existing paths, nonregular targets and symlink/traversal escapes fail; retained file/edit tools remain available for later edits.

The operation executes fixed `/usr/bin/python3 -I` through released `ctx.shell.resolve` / `execute`, with JSON stdin, finite deadline, cancellation signal and the actual Session-resolved sandbox policy. The canonical managed mutation-name gate must include `build_docx`; otherwise a new tool bypasses approval/Auto. Keep all tier semantics unchanged. Output and `presentationMeta` contain `{path, bytes, sha256, uid}` derived from constructed bytes, not model input or a workspace receipt.

The existing observer pairs native `tool/call` and committed `tool/result` by Session, turn, step and call ID, then synchronously parses the requested artifact in `session/event`. Result metadata, boundary bytes and requested content must agree. Native call IDs alone are not unique across steps. Final parsing is separate so later parent edits remain allowed. This is evidence under the tested composition, not cryptographic or employee-tamper-resistant provenance: the office bundle remains employee-writable.

Actual disposable native qualification passed on giap-vps: writer-only model-visible registration, fixed Python through the Session shell policy, metadata replay matching the synchronous independent parse, and managed approval rejection in the genuine child with no file/receipt. Suite16.70s, runner27.174s, empty four resource inventories; `.run/issue217/construction-seam-native.log`. This minimal probe is not complete production proof: Auto/allow/cancel/path/error behavior, permanent implementation and final exact-head gates remain required. The unchanged production surface separately fails the new native tool-availability assertion as expected (suite14.07s); no production constructor was installed for that RED.

Implementation slices are disjoint: production bundle/permission gate/image delivery versus canonical oracle/observer/model acceptance. The parent owns integration and native tier controls; higher-priority independent-slice routing permits these isolated parallel leaves, superseding the skill's one-writer default. Leaves deliver tests first and do not run checks; the parent observes RED before releasing implementation.

## Verification and review contract

- Before edits: strict fixture validation and parent-inline fixture admission under the higher-priority single-mapped-slice delegation restriction. The two independent research leaves do not count as fixture/code reviewers.
- After edits: `pnpm check`, strict standalone/shared OpenSpec, native positive structured construction and negative parent-authored copy, plus native scope, three-tier permission/denial, cancellation, destination/path and error behavior. Run the required complete Docker suite on giap-vps; no permission-bypassing host spawn or user-data migration.
- Real model: same human notice under fresh default general; exact native call/catalog/lineage, writer selection before work, successful task-bound construction and independently parsed DOCX before parent resumes and at final delivery; preserved manual writer and every #82/#84/#85 case. No explicit delegation or new-tool instruction added to the human task.
- Four independent high-risk seats on isolated worktrees: correctness; invariant-state; test-evidence/spec-compliance; security-perf/integration. Re-adjudicate PR216's P1 contribution and P2 descriptor findings against the combined diff. Final exact-head model/full Docker/CI plus inspected screenshots and independent retirement gate the protected merge.
- Tool/skill availability and direct file-task capability are preservation surfaces, not incidental defaults. The existing exact-byte general task and native scope/tier tests remain intact. Failed real-model evidence is not replaced by deterministic adapter success.

## Risks / Trade-offs

- Model compliance is probabilistic → this guidance repair is intentionally smaller than inventing semantic classification; real no-child output still fails, and a passing run is not claimed as a universal guarantee.
- Skill instructions can compete with persona policy → remove contradictory local role guidance in both owned surfaces; do not rewrite upstream or user content.
- Existing employee volumes retain delivered plugin bytes → this change qualifies fresh images/instances, following the current bundle delivery contract. No destructive migration of employee profiles is introduced.
- Combined diff includes substantial reused verification → justify atomicity through diff-limit-exempt, retain its history/negative controls and review the complete diff rather than only the new YAML.
- Native generic tool success and process quiescence do not prove construction → use the explicitly authorized construction contract and qualify its native result boundary. Receipts prove execution, not independent text authorship. Do not substitute filesystem-wide scans, command blacklists or final-byte equality after parent edits.

## Migration Plan

No platform schema, HTTP contract or user-data migration. Build the user image with the canonical office bundle sources; fresh profiles receive the writer operation and corrected guidance. Rollback reverts the bundle change and rebuilds the image without editing DSH or deleting employee data. Keep PR218 unmerged until public-seam qualification, native controls and final exact-head gates pass. Archive only this standalone change after protected merge; the shared Epic change stays open until remaining DAG work and acceptance are complete.
