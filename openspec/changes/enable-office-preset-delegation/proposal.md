# Proposal

## Why

Issue #213 blocks Epic #3 issue #89: the pinned native spawn path inherits office-general, while task17.4 requires an actual office-writer child. The user authorized a separate plugin repair without changing DSH source, version or the acceptance contract.

Issue type: bugfix. Fixture level: expanded (agree with upstream). Blast radius: child composition, permissions, creation ordering, persisted preset identity and packaging. Selected risk packs: public runtime entry; config; auth; concurrency; error/rollback; release; compatibility; documentation. Evidence floor: native semantic RED→GREEN, real lifecycle/permission/cold-read checks, full `pnpm check`, exact-head Docker/model regression and independent review/CI.

## What Changes

- Add creation-time native preset selection to the existing office-agents bundle, restricted to fresh direct one-shot children of office-general.
- Preserve native child ownership, policy handling, cancellation and result delivery; do not implement another provider or edit DSH.
- Deliver the plugin with the existing image seed; include source checks and runtime verification in the established gates.
- Record effective writer identity through the native selection event and projection; immutable creation headers remain honest.

## Capabilities

### New Capabilities

- `office-agents`: supplemental native child preset, isolation and lifecycle guarantees. No main spec exists yet; this reuses the canonical capability path already present in the open Epic fixture. Requirement names here are distinct so later Epic archival can add its original requirements without duplication.

### Modified Capabilities

None. The original task17.4 requirement is unchanged.

## Impact

`plugins/office-agents/`, image copy/seed delivery, plugin check configuration and `platform/test` native-runtime fixtures. No new external dependency, public platform API or model credential path. Existing #88 manual writer and #82/#84/#85 model/permission evidence remain regression gates. Human critical-path review remains deferred to Epic end under prior user authorization; independent agent review does not replace it.
