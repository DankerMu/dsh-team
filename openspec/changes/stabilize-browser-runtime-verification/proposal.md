# Proposal

## Why

Issue #179's missing failure attribution now blocks Epic #3: original full Docker verification twice failed first-use app-ready on the final #76 candidate. A full-context passive capture establishes an uncanceled `ERR_NETWORK_CHANGED` on the required vendor script after document200, but not the causal owner of a nearby host-link event; a passing isolated run cannot resolve that blocker.

## What Changes

- Preserve bounded, sanitized browser request/response/failure evidence at the existing shared browser boundary, alongside existing control snapshots and screenshots, without masking the original failure.
- Attribute the captured network interruption within explicitly authorized bounded rounds. The first three cycles are exhausted and retained unchanged. The user approved continuing the recommended separate AggregateError classification followed by a tighter browser discriminator; the second round permits at most three experiments. Implement the minimum repair at the demonstrated owner only after a discriminating failing scenario establishes that owner; diagnostic-only output is not completion of the authorized blocker repair.
- Preserve existing browser startup, platform/DSH authorization, first-use/session/workspace and permission semantics; no added automatic retry, arbitrary delay, longer deadline, ignored browser error, changed acceptance discovery or DSH-source modification.
- Requalify the real boundary and original full Docker suite on the final exact head, then resume paused #76/PR197 and the remaining Epic DAG. Retain failed as well as passing receipts.

## Capabilities

### New Capabilities

- `browser-runtime-verification`: bounded, safe, attributable browser-startup failure evidence and qualification of the corrected verification boundary without weakening its acceptance oracle. The main spec inventory is currently empty; this is verifier-observable behavior required by #179, not a duplicate product capability.

### Modified Capabilities

None. Existing platform/DSH business requirements remain unchanged.

## Impact

Potential owners already identified: `scripts/probe-mapped-host.mjs`, `scripts/probe-dsh-api-cdp.mjs`, their declarations and real-protocol integration tests; first-use and permission-browser callers under `platform/test`. The existing ignored passive observer/capture supplies research evidence, not a parallel permanent implementation. Host network and Docker metadata may be inspected read-only; any experimental mutation is confined to new, invocation-owned `dsh-team` test resources. No changes to existing intranet services, host-wide network configuration, credentials, dependencies or production deployment are preauthorized.

Issue type: bugfix
Fixture level: expanded / Critical Characterization followed by Construction
Upstream suggested level: absent; expanded because shared browser/process lifecycle and security-sensitive evidence cross host/network/resource boundaries.
Blast radius: browser verifier fidelity, runtime gate availability, cleanup, and accidental evidence disclosure; all existing browser consumers must retain their guarantees.
Selected risk packs: API, Auth, Schema, Resource, Concurrency, Errors, FileIO, Compatibility, Packaging, Docs; Config not selected unless a demonstrated repair requires an explicit fixture revision.
Evidence floor: retained actual RED; independently discriminating owner attribution; safe diagnostic rejection proof; preserved real first-use/permission behavior; normal checks and exact-head full Docker/CI. Failure to establish/repair the owner within the authorized bound remains a blocker, not a claim of success.
