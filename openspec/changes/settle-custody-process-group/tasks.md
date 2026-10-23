# Tasks

## 1. Custody process-group settlement

- [x] 1.1 Add a fixture mode whose leaf spawns a short-lived same-group process with ignored stdio on SIGINT and exits without waiting; add a custody regression that cancels it and requires `settled: true`, `cleanup: confirmed` and duplicate-cancel exit 0. Observe RED on current code (Darwin and Linux container). Add a past-expiry member mode (member spawned at leaf readiness, stdio ignored, ignores SIGINT/SIGTERM, pid/birth persisted under the owned temporary root, retired by single-pid teardown) expecting `settled:false`, `failure:null`, `cleanup: unconfirmed`, status `unknown`, and a cancel sent only after status is `unknown` exiting 1.
- [x] 1.2 Implement the bounded post-close observation (ESRCH only; present and EPERM observed again; 2000ms window, 20ms interval; final EPERM → identity failure; other errors immediate identity failure) through one canonical helper; GREEN. The always-EPERM case keeps its exact expectations within its unchanged 10s/20s bounds; no test bound changed; a loaded-run breach is reported, not absorbed.
- [x] 1.3 The existing late-cancellation case and the new custody regressions pass the sanitized terminal (`command`, `interruption`, `failure`, `cleanup.state`) as assertion messages before the duplicate-cancel assertion; no credentials/proxy values.
- [x] 1.4 Update AGENTS.md Trusted Docker verification for the bounded post-close window, ESRCH-only settlement, EPERM continued observation and fail-closed expiry.

## 2. Darwin dispatch fixture

- [x] 2.1 Warm the fresh fake `docker` executable once, untimed and outside the witness protocol, before the timed dispatch in the selected-dispatch case; bounds and assertions unchanged. The writer reports inner dispatch `status`/`signal`/`error.code`/elapsed on stderr before a nonzero exit. Record one loaded concurrent Darwin run.

## 3. Verification and delivery

- [ ] 3.1 Canonical checks; repeated loaded concurrent runs of the custody and audit suites on Darwin and in a Linux container; review; exact-head trusted custody `pnpm test:docker` and standalone `pnpm test:deploy` with independent observation; protected merge.

## Risk packs

- Selected: concurrency/shared state/ordering → 1.1/1.2; settlement only after genuine group absence, publication order unchanged.
- Selected: error handling/partial outputs → 1.2; EPERM/other errors and expiry remain unsettled, original exit/signal preserved.
- Selected: resource limits/deadlines → 1.2/2.1; one new derived 2000ms observation window, no production or fixture deadline changed.
- Selected: documentation → 1.4; AGENTS.md custody group-absence rule.
- Not selected: public API/CLI (status/cancel/logs interfaces unchanged), config, schema, auth/secrets (evidence messages exclude credentials, 1.3), file IO, compatibility, packaging — no change to those surfaces.
