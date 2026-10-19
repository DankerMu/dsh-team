# Design

Goal: resolve a failed host observation against authoritative same-invocation cleanup evidence without weakening retirement authority or changing execution policy.

What exists: `ci-vps-owner.mjs` owns the independent observer, GitHub retirement, recovery and exact-lock retirement. `ci-vps-worker.ts` writes private atomic final receipts and provides bounded `await`; `ci-vps-run.mjs` pins the owner/receipt writer to the approved SHA. Reuse these owners, paths and process bounds rather than introducing another supervisor or ledger.

Governing invariant: only a valid current same-invocation cleanup receipt (or an existing explicitly verified no-installation path) can satisfy host retirement; a transport failure is not a host result, and execution failure is not cleanup failure.

## Change surface and order

1. Promote the real-owner controlled diagnostic into permanent process fixtures. The real owner and actual owned shell owner/lock predicates run; only git/gh/ssh/keygen external boundaries are isolated. Prove the failed-observer/canonical-success RED and valid execution-failure/foreign-owner controls before changing decisions.
2. Keep observation and authority decisions in the existing owner file. Add one shared bounded receipt validator/projection used by both observation and canonical recovery. Settle observer stdout before parsing; retain fixed outcome/process/elapsed/byte-limit facts separately from the validated host receipt. Do not persist raw JSON extras, output or errors.
3. On a failed/invalid observer only, check current owner and perform one canonical read under the existing190s recovery bound. Reuse the worker's private receipt reader through read-only `await-retirement`, bounded internally to180s so remote observation settles within the outer bound. Preserve the general `await`1800s, observer1850s and all existing host/finalizer/execution limits. A valid cleanup-false receipt is terminal failure, not permission to repeat finalization or read until green. Canonical read output is bounded to the private receipt envelope, not the archive transport allowance.
4. Reconfirm current invocation authority before acknowledging recovery and retain exact-lock matching. Unknown/foreign ownership or invalid/unreachable evidence keeps the lock. Existing no-root/pre-worker cleanup paths remain explicitly separate; no discovery or prefix cleanup is introduced.
5. Document the diagnostic fields and historical UNKNOWN boundary; run actual read-only worker receipt characterization on trusted Linux without provider/capability provisioning, then full verification/review/delivery.

## Verification

- Failed observer then canonical cleanup=true: recorded failed observation, valid canonical projection, whole cleanup only after existing GitHub retirement, exact own lock absent; execution remains failed when its exit is1.
- Valid observer cleanup=true/exit1 and cleanup=false/exit0 remain independent; valid cleanup-false does not trigger read-until-success.
- Actual observer process exit before pipe EOF, malformed/oversized output, spawn/transport/signal failures and bounded canonical missing/invalid/unreachable cases. Controlled fixtures never contact real gh/ssh/provider endpoints.
- Foreign owner before/after observation and foreign active symlink are preserved; only the current invocation's lock can be removed.
- Diagnostics contain only fixed metadata and validated projected fields; sensitive canaries and raw extra fields do not escape.
- Source-pinned bootstrap remains unchanged unless a new production dependency becomes necessary; no helper extraction is planned.

Assumptions: the trusted host/canonical worker remains the authority; local diagnostics are not deletion authority. Controlled reproduction establishes the retained-Promise mechanism only; it does not attribute the historical1853s event.

Containment/rollback: unknown states still retain the exact lock and private evidence for explicit operator recovery. No automatic provider retry, daemon changes, credential-policy changes, resource-cleanup strategy changes or deadline extensions. Revert through git if needed; do not delete retained evidence to claim success.

Review focus: end-to-end observation→validation→recovery→lock identity; process/stream settlement; no credential exposure; finalization/execution remain unchanged. Four independent risk seats review the exact candidate before trusted runtime. Rule-file changes require disclosed deferred human review; no production critical-path directory is planned.
