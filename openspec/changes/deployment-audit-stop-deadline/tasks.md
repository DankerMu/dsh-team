# Tasks

- [ ] Prove controlled20s real platform stop fails with the old15s callback, with owned continuation and cleanup settled.
- [ ] Honor an optional audit command deadline, retain15s default and use45s only around platform stop30s; prove controlled graceful completion and exit0/restart.
- [ ] Prove an overdue real subprocess is killed/closed, audit failure propagates without restart, and actual deployment cleanup removes owned resources.
- [ ] Run local check, original deploy and complete Docker suites with independent empty resource/unit inventories; complete independent review and protected CI.
- [ ] Merge, record SHA-bound evidence and archive the completed fixture.

## Risk mapping

Script contract/compatibility: sole callback migrated atomically; default unchanged; local types/check and real path.
Concurrency/resource lifecycle: verified SIGSTOP/CONT ownership and bounded child timeout; continuation awaited even on failure; genuine cleanup and independent absence checks.
Error propagation: preserve stop/inspect/restart order and exit0; actual timeout fails audit; no retry or relaxed production deadline.
No auth/schema/data migration/config inputs. Existing Docker suite owns unchanged sibling lifecycle cases; no provider run authorized.

## Workflow boundary

Parent inline fixture admission and mapped implementation follow the higher single-slice delegation restriction; not represented as independent fixture review. Expanded independent code/evidence/ownership review before trusted final acceptance. Tests are VPS-only and assert effects/closure, not forwarded constants.
