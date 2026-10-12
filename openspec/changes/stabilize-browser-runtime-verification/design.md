# Design

## Context

See proposal.md for intent and authorized boundaries. The existing actual RED and captured vendor-script interruption are retained under `.run/issue76/`; #76/PR197 is paused, not abandoned or qualified. Work starts from main8d80aeaae6a5c5bcc690ad2f2fe8c730772444eb, independently of the unmerged audit UI.

The shared mapped-host boundary owns Chrome startup, CDP domain setup, request/error collection and navigation. Its transport currently stores one handler per session/method: later session-admission and model-refusal handlers replace earlier handlers. Existing canonical diagnostics retain a safe error code, control snapshot and screenshot but omit response/failure attribution. The ignored passive observer is useful evidence, not a second permanent owner.

Read-only research found material limits in that observer: Node pipe-read timestamps can lag while synchronous Docker calls block the event loop; Docker nanoseconds/compound actions and host interface/object/DAD fields are discarded; registration-only ownership cannot distinguish foreign from unresolved resources. The host is shared. Enabled IPv6/DAD is a hypothesis input, not proof that it caused the captured failure. Research is retained in `.run/issue179/browser-seams.json` and `host-attribution.json`.

## Goals / Non-Goals

**Goals:** identify and remove the demonstrated verifier-owned cause of the network interruption, preserve useful safe failure evidence, and restore honest exact-head qualification. Preserve every original product assertion and browser error/deadline gate.

**Non-goals:** DSH source changes; host-wide network/service changes; access to existing intranet content or secrets; new product APIs; suppressing network-change notifications or treating browser errors as acceptable; adding automatic retries, arbitrary sleeps, longer deadlines or test exclusions. A green isolated run or improved diagnostics alone does not finish the authorized blocker repair.

## Decisions

### 1. Characterization precedes construction

The first authorized work is a bounded diagnostic experiment, not a guessed production fix. Freeze candidate, runtime/tool identities, explicit environment including `DSH_TEAM_REVIEWED_HEAD`, scenario discovery/order policy, original browser flags/deadlines, and pass/fail oracle. Record each diagnosis→repair→reverification cycle under `.run/issue179/`; the new bound is three cycles, initially zero consumed.

The governing invariant is that acceptance describes the real browser/platform/DSH exchange on one candidate: an observer cannot change that exchange, hide its failure, steal another consumer's events or mix identities. Unknown source ownership remains unknown.

### 2. Preserve event identity at collection time

For the next diagnostic, reuse the established source-derived first-use/permission wrappers and bounded observer, extending rather than copying permanent logic. Capture host netlink object/direction, interface index and hashed identity, kind/peer/master index and address-state flags; omit addresses/MACs. A small separate standard-library reader avoids Node's synchronous-call buffering. Record receiver-monotonic and wall-clock anchors; call a timestamp kernel-origin only if an actual kernel timestamp is present. Do not silently fall back to weaker attribution when the reader is unavailable.

Retain Docker `timeNano`, a closed action verb plus compound-action indicator, hashed object identities and explicit own-run/other-project-run/foreign/unresolved classification from selected labels/registered owned identities. Map new owned bridges/veths using selected inspection fields only; never dump container environments, mounts or all labels. A host timestamp alone does not establish ownership or causation.

Browser receipts preserve request identity and latest redirect hop, relative time, method, path-only same-origin classification, resource type, status or safe loading-failure code, cancellation and redirect status. No headers, cookies, query strings, response bodies or raw NetLog. Original errors still reach the original gate. Use bounded rows/bytes and explicit drop/error counters so missing evidence cannot look complete.

### 3. Use one discriminating hypothesis per cycle

Ranked initial hypotheses: delayed owned bridge/veth/address-state notification; unrelated host transition; browser initialization notification independent of an observed host transition. App-startup failure is a competing explanation only when required resources actually arrive successfully.

The first experiment couples an independently timestamped real-context capture with the smallest owned-resource control needed to distinguish the leading hypothesis. A held asset on an invocation-owned local HTTP endpoint can compare no-churn control with one new labelled bridge/veth transition, using the same Chrome/flags and a bounded completion barrier—not sleeps or retries. Only newly created `dsh-team` resources may be changed. A synthetic control qualifies the mechanism and collector; it never substitutes for real DSH acceptance. Bind any mechanism result back to actual first-use and permission evidence before assigning the repair owner.

### 4. Causal repair gate

Before any permanent behavioral repair, the parent must record the constructible failure, causal discriminator, rightful owner, smallest proposed fix and regression oracle here or in an attached design revision, and obtain the fixture review/strict validation required by the issue workflow. This is an explicit construction gate, not a deferrable open question. Unproven network isolation, new dependencies/privileges, host configuration changes and browser flags are not authorized by this fixture. If evidence requires those materially different choices, revise scope with the user rather than guessing.

The original #179 safe-diagnostic behavior may be implemented at the existing shared mapped-host owner once its oracle is qualified. Integrate event ownership explicitly: do not add a handler that another caller silently replaces, monkeypatch production registration, or broaden the transport's listener semantics without auditing every caller. Keep normal successful acceptance return contracts unchanged unless an actual consumer needs a new field; update declarations/projections/callers together if they do. Failure evidence belongs in the existing failure path, not a second logging framework.

### 5. Verification and release remain separate

Permanent collector/repair changes need semantic failing-before/passing-after proof through the real CDP/process/HTTP boundary where practical. Existing model-refusal browser protocol and Chrome child/TCP integration seams are reusable; source-text assertions and mocked echoes are not evidence. Cover observer coexistence, redirects/unknown IDs, late completion/teardown, cap/drop behavior, secret exclusion, and original-error precedence when evidence writing fails.

Run normal checks and all affected real browser consumers: first-use, permission, managed-policy and model-refusal. Full Docker discovery remains original; the final exact-head original suite must pass, followed by one explicitly planned stability run on that same head because this incident is intermittent. Retain every outcome and independently inspect cleanup. Diagnostic variants and older-head success never satisfy the final gate. CI, native review and user-deferred Epic-end human review remain distinct obligations.

## Risks / Trade-offs

- Correlation mistaken for cause → interface/Docker identity joins and a controlled discriminator; label unresolved cases honestly.
- Observer timing masks the race → no awaited event-handler work, independent collector timestamps, compare uninstrumented real acceptance; report remaining observer effect.
- Sensitive error/URL content leaks → closed projections and literal poison-input rejection proofs; never copy raw traffic into artifacts.
- Shared event handlers or projections regress → audit session admission, model refusal, managed-policy and permission consumers; one canonical owner.
- Shared-host changes outlive the owned scenario → do not modify foreign resources; stop at the authorized bound if no safe owner-level repair is established.

## Migration Plan

No stored user data, public API or deployment migration is planned. Refactor the existing helper in place and migrate every affected caller atomically. Remove diagnostic scaffolds after preserving receipts; rollback reverts verifier changes and never changes user data or host services. After #179 merges, rebase/requalify paused #76, restore the paused task queue, and continue its DAG. Archive this standalone blocker change only after its own acceptance; keep the Epic change open until Epic acceptance.
