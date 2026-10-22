# Proposal

## Why

The user chose local Linux/amd64 builds followed by upload and actual VPS acceptance. Existing builders still rebuilt dependencies on the VPS. After the user rejected the oversized framework, scope is only the acquisition seam needed by existing commands.

## What Changes

- One small adapter consumes trusted operator-prepared role-to-OCI-layout mappings through `DSH_TEAM_VERIFICATION_IMAGES`.
- Existing builders keep their native recipes, sync/async behavior, budgets, diagnostics and cleanup. Selected artifacts produce case-owned metadata derivatives; complete Config/RootFS must match except labels.
- Local construction, archive validation, source/transfer provenance and layout lifetime remain trusted operator operations. No generic producer, bundle parser, public CLI, process supervisor or async caller migration is added.
- Full final-head Docker/deployment/stability acceptance remains required. No new model grant.

## Capabilities

### New Capabilities

- `verification-image-artifacts`: optional trusted uploaded-image acquisition for existing verification commands.

### Modified Capabilities

None; source-policy replacement remains separately owned by #313.

## Impact

User/platform/Compose/browser builders, nested browser environment, three existing shell probes, focused regressions and existing operator guidance. Atomic PR314 with #313; prior review history is preserved.

## Risk Triage

Issue type: feature; fixture level: expanded (file inputs and resource ownership).
Selected risk packs: file IO, configuration, identity/ownership, errors, consumer compatibility and packaging.
Evidence: existing public semantic RED, focused native/identity regressions, actual adapter smoke, final reviewed-head local build and original VPS suites.
