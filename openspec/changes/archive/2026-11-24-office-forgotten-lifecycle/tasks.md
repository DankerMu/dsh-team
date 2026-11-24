## 1. Implementation

- [x] 1.1 New `platform/test/document-server-forgotten-fixture.ts`:
  - move `FORGOTTEN_DIR`, `forgottenDirs`, `namespaceForgottenListScript`, `forgottenPresent`, the guarded list call and `registeredKey` (generalised to a path), with its own minimal lane types;
  - `forgottenDirs` fails loudly on a missing dir or a non-integer count;
  - add the guarded, digest-only `removeForgotten`, which returns the count;
  - add `forgottenCopy`, which throws on a list read that is not 200/0.
  - Integration stand-ins, each red-proved: no key in the script or the failure output; a matching entry removed and others kept; the count; the loud failures.
- [x] 1.2 Rewrite `clean`/`unsaved` and the typing case:
  - baseline, the open key via `registeredKey`, and the settle window;
  - `forgotten: { added, listed, cleared }` in the evidence, facts and expectations;
  - `OfficeRewriteLane.namespaceRead`, and the `rewriteLane` stand-in updated;
  - failure-path cleanup that rethrows the original error unchanged, with stand-in cases (settle window injected, no real 15 s sleep).
- [x] 1.3 Forgotten case:
  - the anchor `forgottenDirs === beforeDirs + 1` at the positive control;
  - `kA` handed to the caller on failure through a caller-passed holder, never on the error, and a stand-in showing that the printed failure holds no key;
  - after `recover` and the settle window, `residue: { added, listed }`;
  - cleanup with the count and re-list, and the baseline asserted;
  - failure-path cleanup that rethrows the original error;
  - attack and `recovered` assertions unchanged.
- [x] 1.4 Docs: `docs/EMPLOYEE_GUIDE.md:71`, and `docs/DEPLOY.md` § 7 and § 8 (routine `-mmin` cleanup; volume names recorded before `down`, then `docker volume rm` by exact name), as in proposal.md and consistent with 2.2.

## 2. Verification

- [x] 2.1 Touched integration files three runs in a row; `pnpm lint` (incl. `lint:deps`), `pnpm typecheck`, `pnpm dead-code`, `pnpm duplicate-code` and `pnpm check` exit 0.
- [x] 2.2 Exact-head local `pnpm test:stack`:
  - the anchor holds;
  - the `forgotten` results of the rewrite and typing cases and the forgotten case's `residue` are recorded;
  - only `added`/`listed` may be revised to the measurement, and the docs match it.
- [x] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.

## 3. Fix pass 1 (exact-head measurement and review round 1)

- [x] 3.1 Key-scoped counting: `forgottenCopies(lane, key)` replaces the global `forgottenDirs` count everywhere (anchor `=== 1`, `copies` in place of `added`, `cleared` = removed === copies, copies then 0, re-list false); drop `forgottenDirs`, its baseline and the parent check if unused; evidence fields renamed; docs and README wording follow.
- [x] 3.2 `vitest.config.ts` stack `testTimeout` ledger: one line for #650's added docker execs, namespace reads, registry polling and settle windows, with `testTimeout` and the Sum line updated.
- [x] 3.3 `platform/test/README.md:92`: the `forgotten`/`residue` evidence fields and the key-scoped cleanup assertion.
- [x] 3.4 `document-server-forgotten-fixture.integration.test.ts:270`: prove settle-then-remove by call order, not a 40 ms wall-clock bound.
