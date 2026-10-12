# Proposal

## Why

Issue #179's missing failure attribution now blocks Epic #3: original full Docker verification twice failed first-use app-ready on the final #76 candidate. A full-context passive capture establishes an uncanceled `ERR_NETWORK_CHANGED` on the required vendor script after document200, but not the causal owner of a nearby host-link event; a passing isolated run cannot resolve that blocker.

## What Changes

- Preserve bounded, sanitized browser request/response/failure evidence at the existing shared browser boundary, alongside existing control snapshots and screenshots, without masking the original failure.
- Two bounded characterization rounds are complete and retained. The second round reproduced uncanceled `ERR_NETWORK_CHANGED` for an observed High-priority required request during an owned host-network transition, while its no-transition control passed. The user authorized a bounded repair-and-verification phase: isolate the verification browser's network namespace, preserve the real endpoint path, and prove the retained RED becomes GREEN while the host transition still occurs. Historical triggering-interface attribution remains unresolved.
- Preserve existing browser startup, platform/DSH authorization, first-use/session/workspace and permission semantics; no added automatic retry, arbitrary delay, longer deadline, ignored browser error, changed acceptance discovery or DSH-source modification.
- Requalify the real boundary and original full Docker suite on the final exact head, then resume paused #76/PR197 and the remaining Epic DAG. Retain failed as well as passing receipts.

## Capabilities

### New Capabilities

- `browser-runtime-verification`: bounded, safe, attributable browser-startup failure evidence and qualification of the corrected verification boundary without weakening its acceptance oracle. The main spec inventory is currently empty; this is verifier-observable behavior required by #179, not a duplicate product capability.

### Modified Capabilities

None. Existing platform/DSH business requirements remain unchanged.

## Impact

Owners: the canonical Chrome launcher and shared mapped-host evidence under `scripts/`, all direct/mapped browser callers and declarations, Docker browser fixtures, probe lifecycle cleanup, and a verification-only browser-runtime image and root command wrapper. The Node driver, actual platform gateway, DSH image/source and production deployment remain unchanged. Docker supplies a fresh network-none namespace; owned Unix sockets relay raw application/CDP bytes without header or origin rewriting. The image supplies pinned Node and browser libraries; the existing pinned Chrome distribution is mounted read-only. No host-policy changes, extra privileges, unrelated mounts or intranet-service changes are authorized. The ignored diagnostic collectors remain historical evidence, not a second permanent runtime.

Issue type: bugfix
Fixture level: expanded / Critical Characterization followed by Construction
Upstream suggested level: absent; expanded because shared browser/process lifecycle and security-sensitive evidence cross host/network/resource boundaries.
Blast radius: browser verifier fidelity, runtime gate availability, cleanup, and accidental evidence disclosure; all existing browser consumers must retain their guarantees.
Selected risk packs: API, Auth, Schema, Resource, Concurrency, Errors, FileIO, Compatibility, Packaging, Docs, Config. Config covers explicit native/isolated verification runtime selection, image provisioning and fail-closed prerequisites; no production setting changes.
Evidence floor: retained actual RED; independently discriminating owner attribution; safe diagnostic rejection proof; preserved real first-use/permission behavior; normal checks and exact-head full Docker/CI. Failure to establish/repair the owner within the authorized bound remains a blocker, not a claim of success.
