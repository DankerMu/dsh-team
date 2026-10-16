# Tasks

- [x] Prove controlled20s real platform stop fails with the old15s callback, with owned continuation and cleanup settled.
- [x] Honor an optional audit command deadline, retain15s default and use45s only around platform stop30s; prove controlled graceful completion and exit0/restart.
- [x] Prove an overdue real subprocess is killed/closed, audit failure propagates without restart, and actual deployment cleanup removes owned resources.
- [x] Run local check, original deploy and complete Docker suites with independent empty resource/unit inventories; complete independent review and protected CI.
- [x] Merge, record SHA-bound evidence and archive the completed fixture.

## Risk mapping

Script contract/compatibility: sole callback migrated atomically; default unchanged; local types/check and real path.
Concurrency/resource lifecycle: verified SIGSTOP/CONT ownership and bounded child timeout; continuation awaited even on failure; genuine cleanup and independent absence checks.
Error propagation: preserve stop/inspect/restart order and exit0; actual timeout fails audit; no retry or relaxed production deadline.
No auth/schema/data migration/config inputs. Existing Docker suite owns unchanged sibling lifecycle cases; no provider run authorized.

## Workflow boundary

Parent inline fixture admission and mapped implementation follow the higher single-slice delegation restriction; not represented as independent fixture review. Expanded independent code/evidence/ownership review before trusted final acceptance. Tests are VPS-only and assert effects/closure, not forwarded constants.

RED: parent-owned giap-vps head `c02e554d5e4b39d4c06b3c1ff77d7facd3ddfde8`, original callback, actual slow-stop regression. Docker CLI settled at15015ms with null status before controlled20s continuation; audit-error-retirement failed, no restart. Real cleanup and independent container/volume/network/image/unit inventories empty. This is the previously hypothetical controlled counterexample, not a claim of an observed production flake. Narrow baseline selection excluded the second case intentionally; final acceptance requires both and full original discovery.

GREEN qualification: head `e5cc0c264b6ef7b74cd12cd16b5048434eaec5a2`, both real Docker cases passed. Controlled graceful stop20231ms, stop status0, independent exit0 and restart, complete19-event/4-reason audit acceptance. Overdue external child45022ms, null status, actual SIGKILL closure, no restart, expected audit-phase failure. Independent final resource/unit inventories empty in both qualification runs. Local check2216unit/1190integration passed. These narrow runs qualify the regression, not final full-deployment/Docker acceptance.

Final delivery: [PR260](https://github.com/DankerMu/dsh-team/pull/260) merged as `ae05e68a9fada03731f1d29b979ba75965ce5e03`, closing252. Frozen reviewed head `569c83f7e08b0d15a8c4af3378261c53060a3705`; three seats clean, no findings/fix passes. [Original deploy11/11 and full Docker31files/91tests](https://github.com/DankerMu/dsh-team/pull/260#issuecomment-6215772472) passed in390.71s/1432.99s, with independent empty resources/units. Final full run repeated slow20221ms/exit0/restart and timeout45007ms/real SIGKILL closure/no restart. Protected CI38897372216 passed after exact-head owner attestation; no provider call or bypass. [Merge summary](https://github.com/DankerMu/dsh-team/pull/260#issuecomment-6215838642).
