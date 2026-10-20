# Design

## Context

See proposal.md for motivation. `withAccountUi` currently binds and closes a temporary TCP server before loading configuration, opening SQLite, starting its local upstream and building/listening to Fastify. `withAdminUi` delegates to it; all account/wait/admin UI consumers share this boundary. `buildApp` captures immutable public-Origin strings during construction, so binding Fastify first and mutating configuration later would not repair those consumers.

The canonical byte relay already exists privately in `scripts/probe-browser-runtime.mjs`. It owns incoming/outgoing sockets, preserves raw bytes, ordinary backpressure and orderly half-close, and destroys only its paired sockets on failure/close. Duplicating that transport or importing the entire Docker runtime into a platform UI fixture would establish the wrong dependency.

Two real feasibility probes were rejected: actual `buildApp` over an owned Unix socket returned health200 but registration500; production source-address validation requires a valid IP peer. A pinned Fastify prebound `serverFactory` served health200 but retained its listener after `app.close`; its normal `listen` path would bind again, and its custom-server close path depends on internal listening state. No source-address spoofing, private-handle/state mutation or production builder seam is introduced to make either alternative work.

## Goals / Non-Goals

Goal: one continuously owned public listener and one immutable browser Origin, with explicit readiness and complete owned-resource settlement. Preserve the real TCP peer, existing platform APIs/assets/database, authentication and observers.

Non-goals: production networking/configuration changes, HTTP proxy semantics, startup buffering, retries, shared fixed ports, new global deadlines, relaxed request failures, provider execution or attribution of the historical conflicting listener.

## Decisions

### Retain the public TCP listener; bind the backend independently

Bind the invocation-owned public listener to loopback port0 once. Derive `baseUrl` and platform public-Origin configuration from that actual bound address and never release or rebind it. Build the real app and let Fastify bind a separate loopback port0 through its normal lifecycle. Activate raw forwarding once to that inspected backend endpoint, then create API/browser consumers. Host/Origin/cookie/HTTP/WebSocket bytes are unchanged, and the backend still sees a real loopback TCP peer.

Before activation, accepted sockets are tracked immediately and closed; no service is promised before fixture readiness. Do not buffer requests, connect to port0, mutate a live destination or retry. A second activation or activation after closing fails explicitly. The extra verification-only socket hop is disclosed; this is not a claim that browsers directly bind Fastify's listener.

### One canonical relay and one activation transition

Extract the existing byte listener into a dependency-light verification module. Preserve its byte piping, backpressure, orderly EOF and paired error behavior. Provide explicit one-shot destination activation; migrate all existing runtime call sites to activate their already-known fixed destinations immediately. Closing fences further activation/admission and waits for captured owned sockets and the listener to close. Remove the old private implementation rather than retaining an alias.

Update every module-delivery closure in the same change: browser runtime build context, verification-image COPY list and trusted VPS rescue bundle. Existing browser transport regression and original full Docker discovery must qualify the changed head. Model authorization and provider behavior are not changed or exercised.

### Deterministic fixture boundary, not probabilistic contention

Expose two phases of one optional fixture-only awaited initialization observation. The early public-Origin-selected phase runs immediately after selecting the URL and before database/upstream initialization or any further fixture ephemeral bind. On the original path the reservation has already closed; the independent contender acquires and holds that exact address before initialization resumes, so the real Fastify listen produces the required EADDRINUSE. On the repaired path the public listener remains bound and the same contender is refused. Contender ownership/refusal is recorded separately from the subsequent application outcome; no historical contender is inferred.

The later initialized-resources phase supplies the same public URL and owned app/database handles after construction but before backend listening and consumer admission. It induces setup failure after resources exist and supports a separate held-initialization competing-bind check. Callback failure and normal completion remain separate cases. No mock replaces app, database, assets, authentication, Origin policy or the existing browser request observer. `withAdminUi` continues delegating all options and ownership to `withAccountUi`.

### Cleanup retains primary failures and attempts independent resources

Fence and close the public relay so no new browser connection enters, dispose the owned API context and settle the real app/service/database through their existing ownership boundaries. Attempt independent cleanup even after an earlier error. Preserve the scenario error and aggregate cleanup failures rather than replacing it. Do not delete private paths while resource settlement is unconfirmed. Playwright still owns its page/context/browser lifecycle; the fixture never closes a foreign browser or listener.

## Verification

First add the deterministic old-boundary test and observe the actual EADDRINUSE failure. Then land retained ownership and prove competing bind exclusion, real same-Origin registration/login and wrong-Origin rejection. Verify normal, initialization-failure and callback-failure settlement with port rebinding, closed database handles, early socket closure and an independently usable unrelated listener. Exercise canonical relay activation/closure boundaries and existing pressure/half-close cases. Run current full `pnpm test:ui` discovery with unchanged screenshots and zero-unexpected-console/page/request/external-request checks, not a historical narrowed41-test selection. Final exact-head CI and trusted full Docker/Compose plus independent host/resource fences remain required.

## Risks / Trade-offs

- Shared relay extraction affects verification-image and rescue closure → atomically migrate all copy manifests and qualify existing consumers on the final head.
- Added TCP hop could change transport shutdown behavior → reuse canonical byte handling, prove real auth/Origin and keep full browser observers unchanged.
- Early accepted sockets could outlive failed initialization → track immediately and prove close before cleanup succeeds.
- Cleanup failure could hide the original assertion → retain both errors and preserve unresolved paths, never report a successful teardown from partial evidence.

## Migration Plan

No production migration. All UI callers keep the existing public fixture interface except an optional test-only initialization observation. Existing browser relay callers switch atomically to the extracted implementation. Roll back through a normal source revert when no invocation is active; retain unresolved fixture evidence. #304's already-reviewed frozen execution is independent and cannot attest this later shared-transport change.
