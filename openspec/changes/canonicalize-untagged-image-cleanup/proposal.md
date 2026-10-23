# Why

Docker 29 names an absent untagged image by its normalised reference (`No such image: <name>:latest`), while `isAbsentResource` matches the exact caller name. #274 fixed the custody assessor (`scripts/trusted-docker-audit.mjs` `requireAbsent`) and #315 the artifact admission (`scripts/verification-image.mjs:77`), each with its own copy of the rule. `platform/test/docker-cleanup.ts` `removeOwned` still inspects untagged image names raw, so an image that never existed or was already removed is reported as a cleanup failure (issue #317). The currently reachable path is artifact mode whose `${prefix}-image` build fails: a genuine build failure gains a false `cleanup unconfirmed`. The model worker finalizer is a latent path.

# What Changes

- One exported canonical image-reference helper next to `isAbsentResource`; untagged names become `<name>:latest`, tagged references and `sha256:` IDs are unchanged.
- `removeOwned`'s image branch uses that reference for the ownership inspect, absence decision, removal and post-removal recheck.
- `verification-image.mjs` and `trusted-docker-audit.mjs` reuse the helper instead of their own copies.
- `isAbsentResource` exact matching, container/volume/network behavior and ownership fences are unchanged.

# Capabilities

## Modified Capabilities

- `verification-image-artifacts`: owned image cleanup recognises the canonical reference of untagged names.

# Impact

`platform/test/docker-command.ts`, `platform/test/docker-cleanup.ts`, `scripts/verification-image.mjs`, `scripts/trusted-docker-audit.mjs` and their tests. Shared `removeOwned` callers (user-image, platform-image, deployment fixtures, model finalizer's browser-image ID rescue) use tagged names or IDs and are unchanged; the finalizer's journal replay is the latent untagged path this change covers. No production source, schema, dependency or workflow change.

# Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (expanded: shared cleanup/delete path and shared helper)
Blast radius: false cleanup failures or, if wrong, deletion of a differently referenced image
Selected risk packs: error handling/partial outputs; legacy compatibility; release/packaging
Evidence floor: RED/GREEN removeOwned regressions with the real Docker 29 diagnostic, artifact build-failure regression, canonical checks, exact-head Docker/Compose
