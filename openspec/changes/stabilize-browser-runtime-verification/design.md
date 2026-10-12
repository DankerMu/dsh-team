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

Both authorized characterization rounds are exhausted and retained unchanged. The user has now authorized the proposed bounded repair-and-verification phase, not more open-ended diagnosis. Use the existing two review fix passes and repository maximum three fix-and-recheck cycles per failing check; do not reset a gate. Freeze treatment/oracle/candidate/runtime identities for each verification. No automatic retries, full-suite reruns until green, or unbounded extension.

The governing invariant is that acceptance describes the real browser/platform/DSH exchange on one candidate: an observer cannot change that exchange, hide its failure, steal another consumer's events or mix identities. Unknown source ownership remains unknown.

### 2. Preserve event identity at collection time

Characterization reused source-derived first-use/permission wrappers and a bounded observer. Its independent standard-library receiver retained host netlink object/direction, hashed interface identity, kind/peer/master and address-state flags without addresses/MACs. Receiver-monotonic/realtime anchors were explicit; no invented kernel timestamp or Node-receipt ordering proof was used. Preserve these historical receipts and the same independent host-transition evidence for the treatment oracle; the full investigative collector is not a new permanent runtime dependency.

Retain Docker `timeNano`, a closed action verb plus compound-action indicator, hashed object identities and explicit own-run/other-project-run/foreign/unresolved classification from selected labels/registered owned identities. Map new owned bridges/veths using selected inspection fields only; never dump container environments, mounts or all labels. A host timestamp alone does not establish ownership or causation.

Browser receipts preserve request identity and latest redirect hop, relative time, method, path-only same-origin classification, resource type, status or safe loading-failure code, cancellation and redirect status. No headers, cookies, query strings, response bodies or raw NetLog. Original errors still reach the original gate. Use bounded rows/bytes and explicit drop/error counters so missing evidence cannot look complete.

### 3. Use one discriminating hypothesis per cycle

Ranked initial hypotheses: delayed owned bridge/veth/address-state notification; unrelated host transition; browser initialization notification independent of an observed host transition. App-startup failure is a competing explanation only when required resources actually arrive successfully.

The first round's full diagnostic additionally failed `container-start.docker.test.ts` with AggregateError while first-use and permission passed. Historical nested errors and stage context were not retained and cannot be reconstructed. The second round qualified bounded ordered errors/cause graphs, stage/role evidence, original exception identity and poison/cycle rejection, then ran the unchanged startup file once: three cases passed with independent cleanup. Accessor-backed stack fields remained unreadable and explicitly optional; required event/cause/loss/cleanup gates were not waived. This is a separate non-reproduced failure class, not a browser root cause or a claimed treatment success.

The first round coupled independently timestamped real-context capture with an owned-resource held-asset control. Its third experiment witnessed a new non-tentative IPv6 address, not a tentative-to-terminal DAD sequence, and did not reproduce the original browser error. Unequal observation windows limit that comparison. Do not repeat that control unchanged: any next browser experiment must tighten the original failing timing or observe the hypothesized notification, using a bounded completion barrier—not sleeps or retries. Only newly created `dsh-team` resources may be changed. Synthetic controls never substitute for real DSH acceptance; bind mechanism evidence back to actual first-use and permission behavior before assigning the repair owner.

### 4. Causal repair gate

The construction counterexample is `.run/issue179/round-2/experiment-3/controls.json`: six distinct held HTTP1 connections and an observed High-priority required request not yet received by the server; no-transition succeeds, one owned host-network transition yields uncanceled `ERR_NETWORK_CHANGED`, no target server receipt and the original readiness timeout. Pinned Chromium source supports immediate IP-observer cancellation of pending requests. The original first-use bind-back passed and its vendor requests were High; this strengthens relevance but does not reconstruct the historical pool state or triggering interface. The rightful treatment owner is verification-browser launch/network lifetime, not production routing or DSH. Native fixture review and strict validation of this construction revision precede permanent edits.

The original #179 safe-diagnostic behavior may be implemented at the existing shared mapped-host owner once its oracle is qualified. Integrate event ownership explicitly: do not add a handler that another caller silently replaces, monkeypatch production registration, or broaden the transport's listener semantics without auditing every caller. Keep normal successful acceptance return contracts unchanged unless an actual consumer needs a new field; update declarations/projections/callers together if they do. Failure evidence belongs in the existing failure path, not a second logging framework.

#### Selected treatment and alternatives

- Keep the Node driver and real platform/DSH endpoints on the host. Start verification Chrome in a fresh Docker `--network none` namespace with stable loopback; no published ports, Docker socket, host networking, extra capabilities or host-policy changes.
- Application path: private `127.0.0.1:P` → owned mounted Unix socket → original host `127.0.0.1:P`. CDP path: host `127.0.0.1:D` → owned mounted Unix socket → private Chrome `127.0.0.1:D`. Use the same numeric ports across namespaces; preserve the debugger WebSocket URL verbatim and reject a port collision. The browser still visits its original URL, and first-use still traverses real platform session admission and gateway credential substitution.
- One raw duplex stream per accepted TCP connection; preserve backpressure, EOF/half-close, upgrades, reset and cancellation. No HTTP parsing, pooling, proxy-header injection, retries, cookie rewriting or preloading. Required failure evidence is safe CDP metadata only, never relayed traffic.
- Provision a verification-only image through root package scripts, based on Node 24.13.1 bookworm-slim at immutable digest `sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2`, with Chrome's declared Debian runtime dependencies. Mount only the pinned CfT 140.0.7339.82 distribution read-only and invocation-owned profile/socket paths; do not mount host library trees, home, root filesystem or credentials. Resolve the built image to an immutable ID and record image/Chrome identities. Image preparation is outside the unchanged browser navigation deadline and runs once per command invocation; its own failure is fatal.
- Select runtime explicitly at the canonical `startChrome` owner. Trusted Linux amd64 Docker browser tests and both browser probe commands use isolated mode with fail-closed prerequisites. Native mode remains explicit for Docker-independent process/CDP integration tests and supported host use; it is not an isolation acceptance result. Reject isolated mode on unsupported platforms, including unproved Docker Desktop UDS sharing. No silent native fallback.
- Rejected: status quo leaves the reproduced vulnerability; unprivileged user/net unshare failed with uid_map EPERM and bwrap is absent; mounting host runtime library closures couples broad host filesystem/dependency state; moving the whole driver adds database/Docker/control API migration without improving the demonstrated boundary. A small image plus two byte relays is reversible and maintainable by one operator. Revisit only for demonstrated extra browser origins or supported-platform requirements, not speculative routing abstraction.

#### Canonical API and termination ownership

Refactor the existing launcher in place to one explicit launch input carrying runtime, original origin, profile, lifecycle receipt and existing extra flags; migrate every caller/declaration atomically. Keep `connectPage` and successful navigation semantics unchanged. Preserve the effective existing Chrome flag set, not a notification-disabling workaround. Remove obsolete positional signatures, PID-only rescue paths and dead process fields rather than adding compatibility shims.

Register a unique project-owned container name/nonce and durable private lifecycle receipt before partial creation. Record immutable container identity once available; validate ownership and selected image before external cleanup. Never treat Docker CLI PID or container-internal PID as a native host Chrome PID. Canonical normal stop, failed startup and shell timeout/signal rescue must settle Chrome/container, both relay directions, all accepted sockets/listeners and owned socket files before caller profile cleanup. Missing or mismatched identity fails closed; no prune, foreign disconnect or guessed PID kill. A killed driver must leave enough bounded nonsecret receipt for the independent outer cleanup owner. Native cleanup retains its native-process semantics through the same explicit receipt contract.

The pre-create receipt is an explicit pending-identity state, not permission to delete by name alone. If and only if no container ID has ever been recorded, rescue may inspect the pre-registered name, require exact name, private nonce/run ownership and expected immutable image identity, then atomically record the returned immutable ID and remove by that ID. No matching object means verified absence; missing/mismatched authority means refusal. Once an ID is recorded, any ID mismatch is fatal and cannot trigger re-adoption. Prove interruption between create and receipt publication, plus wrong-label/image/name and recorded-ID ABA refusal.

#### Implementation and verification order

1. Qualify namespace/Unix-socket transport and the runtime image at real boundaries; no treatment claim until private and host network identities are demonstrably distinct and real loopback HTTP/CDP works.
2. Implement canonical launch, relay and termination ownership; migrate Linux Docker/probe consumers and explicit native integrations together. Cover partial creation, failed discovery, abnormal child exit, signal/timeout rescue, active-socket shutdown and foreign-identity refusal.
3. Integrate bounded failure context at the shared CDP/mapped-host owner without stealing consumer callbacks. Retain latest redirect hop/status/error/cancellation and explicit loss; preserve primary failure when evidence persistence fails.
4. Exercise the retained controlled RED under treatment: same occupied-connection and actual High-priority/nonreceipt preconditions, host bridge/address change still witnessed, but target HTTP200, original readiness and zero-error gates pass. Preserve the no-transition control. If relay behavior removes queue preconditions or host mutation does not occur, the oracle is invalid, not GREEN.
5. Run unchanged first-use through real platform auth/gateway, all other existing browser consumers, normal checks, native cross-review, exact-final-head full Docker plus the planned stability run and CI. Preserve the separate unclassified AggregateError history; do not claim this treatment repaired it.

### 5. Verification and release remain separate

Permanent collector/repair changes need semantic failing-before/passing-after proof through the real CDP/process/HTTP boundary where practical. Existing model-refusal browser protocol and Chrome child/TCP integration seams are reusable; source-text assertions and mocked echoes are not evidence. Cover observer coexistence, redirects/unknown IDs, late completion/teardown, cap/drop behavior, secret exclusion, and original-error precedence when evidence writing fails.

Run normal checks and all affected real browser consumers: first-use, permission, managed-policy and model-refusal. Full Docker discovery remains original; the final exact-head original suite must pass, followed by one explicitly planned stability run on that same head because this incident is intermittent. Retain every outcome and independently inspect cleanup. Diagnostic variants and older-head success never satisfy the final gate. CI, native review and user-deferred Epic-end human review remain distinct obligations.

## Risks / Trade-offs

- Correlation mistaken for cause → interface/Docker identity joins and a controlled discriminator; label unresolved cases honestly.
- Observer timing masks the race → no awaited event-handler work, independent collector timestamps, compare uninstrumented real acceptance; report remaining observer effect.
- Sensitive error/URL content leaks → closed projections and literal poison-input rejection proofs; never copy raw traffic into artifacts.
- Shared event handlers or projections regress → audit session admission, model refusal, managed-policy and permission consumers; one canonical owner.
- Shared-host changes outlive the owned scenario → browser network-none isolation; owned host mutation still occurs in the regression, and no foreign resources are changed.
- Relay or namespace changes bypass real routing or alter connection occupancy → preserve original URLs and one-to-one raw streams; prove authority/cookie/HTTP/WS bytes and actual High-priority queue preconditions.
- Driver death leaks an isolated browser → pre-creation ownership receipt plus independent identity-checked shell rescue and post-run Docker/socket inventories.
- Runtime image or mounted browser drifts → immutable base/image identity, pinned existing Chrome version/artifact, explicit prerequisites, no silent fallback; no production image dependency changes.

## Migration Plan

No stored user data, public API or deployment migration is planned. Refactor the existing helper in place and migrate every affected caller atomically. Remove diagnostic scaffolds after preserving receipts; rollback reverts verifier changes and never changes user data or host services. After #179 merges, rebase/requalify paused #76, restore the paused task queue, and continue its DAG. Archive this standalone blocker change only after its own acceptance; keep the Epic change open until Epic acceptance.
