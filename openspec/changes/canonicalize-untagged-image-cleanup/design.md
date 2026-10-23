# Context

`removeOwned(command, kind, name, runId, ownership?)` first inspects each ownership label, treats exact absence as already retired, refuses a mismatched label, removes, and—when ownership was supplied—rechecks exact absence. For images Docker resolves an untagged name to `<name>:latest` and reports absence with that reference, which the exact predicate rejects.

# Goals and non-goals

Governing invariant: every image operation in one retirement names the same canonical reference, and absence is accepted only when Docker names exactly that reference.
Must preserve: `isAbsentResource` exact-match semantics; tagged references and immutable IDs; label ownership refusal; container/volume/network paths; existing callers' failure aggregation.
Non-goals: broader name parsing (registry ports, digests), changing journal name rules, the #318 observer directory, or browser image never-created ownership (#319).

# Decisions

1. Add `canonicalImageReference(name)` in `platform/test/docker-command.ts` beside `isAbsentResource`: returns `name` when it contains `:`, otherwise `${name}:latest`. Actual image inputs are: tagged fixture names (`dsh-team-test-<runId>:<probe|platform>`), immutable `sha256:` IDs, the artifact probes' untagged `dsh-team-probe-*-<run_id>-image` (validated only by `startsWith('dsh-team-')`), and cleanup-journal names (`^dsh-team-[a-zA-Z0-9_.:-]+$`). Tagged names, IDs and `@sha256:` digests keep their `:` and stay unchanged. An untagged registry-port reference or short ID is outside these inputs; if one appeared it would be left unchanged and fail closed, never broaden deletion. For an existing untagged image, Docker resolves `name` and `name:latest` to the same object.
2. In `removeOwned`, compute `reference = kind === 'image' ? canonicalImageReference(name) : name` once and use it for the label inspect, `isAbsentResource`, `rm` and the post-removal inspect. Error messages keep the caller's name.
3. `scripts/verification-image.mjs` admission and `scripts/trusted-docker-audit.mjs` `requireAbsent` call the helper; their behavior is byte-identical to today.
4. Removing the canonical reference is the same object Docker resolves for the untagged name, so no foreign image becomes deletable.

# Verification

New `platform/test/docker-cleanup.integration.test.ts` drives `removeOwned`/`cleanupTargets` through a fake command that returns the exact Docker29.1.3 text `Error response from daemon: No such image: <name>:latest` (exit1, empty stdout): never-created and already-removed untagged images retire without error; an existing untagged owned image's label inspect, `rm` and post-removal inspect argv all name `<name>:latest`; tagged and ID targets are unchanged; a foreign reference diagnostic, non-1 exit status or label mismatch still fails. A library-level composite regression replays `verification-image.mjs:159-165`: `registerCleanupTarget` for an untagged image, a failed build, then `cleanupTargets` — RED `failures.length === 1`, GREEN `0`. The CLI prints `cleanup unconfirmed` only when failures are nonempty (`:173-176`), and its build failure exit is unchanged; no CLI injection seam is added. Existing audit/admission tests stay green.

Real-Engine evidence for the untagged diagnostic is the issue's Docker29.1.3 reproduction plus the trusted-host custody run on fd27236, whose assessor confirmed retirement through the canonical `:latest` reference. Exact-head trusted Docker/Compose register only tagged names and IDs, so they prove no regression of those paths, not the untagged branch.

# Risks

[Helper misclassifies a name] → the enumerated inputs above are the only callers; anything else stays unchanged and fails closed; regressions pin tagged/ID identity. Rollback is a normal revert.
