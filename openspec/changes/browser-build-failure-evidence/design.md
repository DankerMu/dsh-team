# Design

## Goal and existing owners

The root verifier owns image build admission, the private image receipt and cleanup. `docker-command.ts` already implements safe build-result classification and allowlisted BuildKit header projection. `writeReceipt` supplies atomic private publication. The model rescue reader requires a valid immutable image ID and invocation label; the wrapper Docker fixture additionally requires built state for its successful acquisitions.

## Governing invariant

Diagnostics never become cleanup authority: only the existing current invocation, immutable image identity, owner label and unchanged tag fence permit image removal; absent or unreadable evidence remains unconfirmed.

## Scope and sequence

1. Add a real-root-process regression for one failed build, with only external process/host qualification boundaries isolated. Require failure persistence, no test child, no second build and no sensitive canary in output/receipts.
2. Extract the existing diagnostic implementation to one shared script module and migrate its existing Docker-command caller atomically. Preserve existing projected fields, classification precedence, output caps and original exception-attribute privacy protections. No raw stdout/stderr or arbitrary exception property enters evidence.
3. Catch image build failure at the original result boundary, publishing state `build-failed` and failure phase `image-build`. Initial build-submitting and successful built semantics remain. Keep the original600s build deadline, kill policy and16MiB capture limit.
4. Extend the same receipt with cleanup outcomes: browser resources confirmed/unconfirmed; image confirmed/ownership-unconfirmed/removal-failed/blocked. A failed inspect, malformed ID, foreign label or changed tag cannot authorize removal. A verified image may be recorded before its exact-ID removal; browser rescue failure continues to block image removal. Removal-call failure stays a failure, not a resource-leak assertion.
5. Keep qualification.failure.json exclusively for qualification after a successful build. Image-build failure does not enter qualification or test discovery. Publication failure must remain explicit and nonzero without printing raw errors.
6. Audit image readers: preserve strict model rescue on null/unknown identity, preserve its existing exact-ID absence handling, and preserve normal wrapper-fixture built-state expectations. Add consumer coverage only where the emitted contract changes their behavior.

## Verification

- Original build exits nonzero, deadline, spawn failure or output limit: bounded classifications from that attempt, terminal image failure, no verification child or retry.
- Sensitive stdout/stderr, malformed headers and exception metadata: only existing allowlisted projections survive; canaries absent from all published evidence and terminal output.
- Missing/uninspectable image, foreign ownership, malformed immutable ID and changed tag: explicit unconfirmed cleanup, no delete; unrelated sentinels untouched.
- Failed build with independently verified owned image: exact-ID cleanup may complete while the command remains failed; failed removal is classified separately.
- Successful build followed by qualification failure: existing qualification receipt remains, not image-build failure evidence; cleanup authority unchanged.
- Receipt-write failure: explicit nonzero outcome, no fabricated durable success.
- Run narrow integration cases, canonical checks, high-risk four-seat review, trusted exact-head original Compose/full Docker and independent resource/host-fence checks.

## Non-goals and containment

Do not diagnose Docker network/build internals, replay failed real builds to retrieve logs, use Buildx history, change proxy/daemon/image configuration, add retries or deadlines, widen discovery, call providers or alter model authorization. No production platform behavior changes. Revert code through git if needed; retain private unconfirmed receipts for explicit recovery rather than claiming absence from an empty inventory. Human acceptance remains deferred and UNPASSED.
