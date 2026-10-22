# Design

## Decision and invariant

Trusted operator-prepared OCI layouts feed a small synchronous preparation/verification helper. A case receives its own image and may change only its labels; shared input files never enter case cleanup authority. This replaces the abandoned generic artifact framework following the user's explicit scope correction.

`prepareVerificationImage(role, tag, labels, directory, command)` returns optional build arguments plus a post-build identity check. Unset selection preserves the existing native branch. Empty, missing, malformed or mismatched selection rejects; it never silently falls back. Existing synchronous user-image overloads and asynchronous deployment command execution remain unchanged.

The private mapping has `roles.user`, `roles.platform`, `roles.browser`, each with `layout`, `manifestDigest`, `configId`. Bounded no-follow private reads verify manifest/config digests and Linux/amd64 config. An absent case tag is established before cleanup registration. Derivation uses `FROM base` and an exact local OCI named context, no RUN/COPY/syntax directive, network=none and pull=false. Complete Docker-inspected Config/RootFS must match the selected config except requested labels before runtime use.

The operator, not this adapter, builds the final reviewed commit, validates/extracts the archive, verifies trusted transfer hashes and keeps layouts unchanged until all actual verification work settles. This is not an untrusted archive-import API or daemon cache ownership claim. No shared base image object is loaded.

## Consumers and preserved behavior

- user-image-fixture, standalone platform-image and deployment fixtures retain their native commands, error handling, cleanup and captured IDs.
- Root browser provisioning keeps pre-build receipt ordering, original failure projection and six-file in-image closure; nested wrappers forward the mapping only to host acquisition.
- The three shell probes use the same helper's narrow internal invocation only when selected. API/first-run retain180s outer bounds; sandbox retains no build deadline. Ordinary fixture/browser builds retain600s/16MiB.
- Cookie-retag metadata building, e2e host TypeScript building, complete discovery and all runtime oracles remain unchanged.
- No mapping reaches renderer/container environments. Model missing-key checks and separate authorization remain intact.

## Evidence and limits

The existing browser process fixture observed a broken explicit selection still making one native build attempt (expected zero), then the permanent regression passes after cutover. Identity regressions reject non-label Config or layer drift and foreign tags. Actual adapter smoke derived and verified an owned image and retired it. Older mechanism probes are not final acceptance.

Final acceptance rebuilds all roles locally from the reviewed combined head, transfers those exact artifacts, and runs original full Docker, standalone deployment and same-candidate stability verification on giap-vps, with independent resource/host retirement and same-head CI. Human review remains deferred/unpassed.
