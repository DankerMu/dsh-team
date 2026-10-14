# Design

## Context

The published rc.2 spawn driver awaits `agents.create`, whose publication awaits serial `agent/created` listeners, before submitting the child's prompt. Public `agentPresets.select` rebinds a blank Agent and commits its selection; the child header is an immutable creation fact. Parent-verified released sources and two independent research reports are retained under `.run/issue89/`.

## Goals / Non-Goals

- Governing invariant: only an eligible fresh general child is rebound, and its first work, effective preset and durable selection agree on writer without changing its parent, siblings or permission identity.
- Must preserve: native spawn provider, parentSession/origin/cwd/model inheritance, native lifecycle owner, managed child approval/Auto/Yolo, manual writer, other presets, fork/continuable/resume and all existing model scenarios.
- Non-goals: a generic preset router, custom provider runtime, DSH patches/upgrades, permission redesign, other office Agents, #89's real-model natural-language scenario, #90's catalog, or rendered Office layout.

## Decisions

1. Extend the existing bundle with a host-side plugin. Use the awaited native creation hook and `select(actualChild,'office-writer')`, not a synthetic parent, metadata rewrite or replacement provider. The latter duplicates subtle cancellation/ownership code; persona-only delegation fails preset identity. Source feasibility is established; native runtime feasibility must pass before adopting production code.
2. Restrict admission to startup, origin=subagent, explicitly unseeded direct child, live general parent and still-general child. Exclude continuable descriptors already present during creation; they are appended in native setup, unlike one-shot descriptors appended before the first step. Resume and seeded fork are never rewritten. Selection failure propagates: no fallback to general work.
3. Reuse native selection ordering and disposal. Check the hook's creation signal before/after awaiting selection; do not swallow errors or retain Agent maps. The plugin subscription belongs to its Cordis scope. Keep managed permission normalization and actual parent ownership unchanged.
4. Effective identity is selection event + projection + live composition/tool and prompt evidence, with selection before turn/start. The immutable header may retain general, as in existing manual selection; cold reads must replay writer from the log. Never require a fabricated header value.
5. Package runtime code with the existing employee-configurable office bundle and full profile seed. This is functional preset behavior, not a new security authority; permission-tiers stays root-owned and unchanged. Register plugin source checks without exclusions or new dependency installation.

## Verification / Failure Model

- Real rc.2 spawn in an owned image: unchanged bundle yields general (semantic RED); candidate yields writer before first child turn, with native lineage, writer instructions/tools and actual successful result. Concurrent children cannot mutate parent/sibling bindings.
- Exercise actual child mutations under all three managed tiers: rejection has no effect, approval/Auto actions retain child-owned decisions, Yolo remains question-free. Keep existing complete permission/browser/model suites.
- Missing/broken writer rejects creation without child work. Pre-abort/running cancel/creation failure/disposal settle and remove live children; do not claim native persisted failed-session metadata is deleted.
- Roots, other presets, seeded forks, continuable children, resume and already-writer cases retain their existing identities. After disposal, read the real subagent address and verify parent lineage, selection and writer projection.
- Sibling surfaces: bundle registration, image copy and seed, native lifecycle/preset/permission hooks, live and cold Session readers, plugin check discovery, current model harness and docs.

## Risks / Trade-offs

- Header versus effective identity → independently check native event/projection and actual capability set, not labels.
- Async rebind races or lease leakage → real cancellation, failure and sibling tests; retain native lifecycle ownership.
- Released API changes → exact peer pin and real-image regressions; revisit on DSH upgrade or when further office presets require routing.
- Creation callback ordering → prove the actual image with managed permissions loaded, not a fake callback registry.

## Migration Plan

Add plugin and bundle activation atomically; empty profiles receive the complete image seed, existing profile protection remains unchanged. Rollback the plugin, activation and related image copy as one revert; retained selection records remain ordinary native preset events. Advance #89 only after this independent issue merges and archives; shared Epic fixture stays open.
