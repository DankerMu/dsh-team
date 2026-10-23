# Tasks

## 1. Bounded readiness

- [ ] 1.1 Add a local atomic `publish` to the generated leaf script (`.pending` at mode 0600, then rename) and use it for `child-ready.json` and `group-member.json` (design decision 1).
- [ ] 1.2 Add one readiness helper with leaf-record, sentinel-file and `fixture-begin` predicates, readiness-first polling at 50ms, deadlines of 5000ms from `start()` (shared with `fixture-begin`) and 2000ms for the sentinel, fail-fast on `result.json`, owner `ESRCH` or sentinel exit, and fixed cause tokens ahead of `terminalEvidence` (decisions 2–4). Replace every listed readiness `vi.waitFor` (`:47`, `:223`, `:279`, `:296`, `:304`, `:356`, `:364`, `:395`).
- [ ] 1.3 Add the `early-exit` mode and its fail-fast regression with the exact expectations in decision 5. Observe RED with the old wait first, then GREEN.

## 2. Verification

- [ ] 2.1 Run the inputs and expected outputs in design "Verification": Darwin sequential and 4-concurrent runs; Linux container 4 concurrent and 6 concurrent + 8 burners, full file, at least 10 rounds per tier, zero readiness-stage failures, every other failure listed, per-test durations against 20s. Canonical checks; review; exact-head trusted custody `pnpm test:docker` and standalone `pnpm test:deploy`; protected merge.

## Risk packs

- Selected: concurrency/shared state/ordering → 1.1/1.2, verified by 2.1's loaded Linux and Darwin 4-concurrent runs; the 1/288 empty-file race is the Darwin case.
- Selected: resource limits/deadlines → 1.2/2.1; 5000ms/2000ms derived from #324 measurements and budgeted inside unchanged 20s test bounds.
- Selected: error handling/partial outputs → 1.2/1.3; cause-marked fail-fast with sanitized evidence; deadline expiry is its own cause.
- Selected: file IO/overwrite → 1.1; same-directory rename inside the owned temporary root, no new paths.
- Not selected: public API/CLI, config, schema, auth/secrets (evidence reuses the existing sanitized projection), compatibility, packaging, documentation — no product surface changes. Non-goals: the default 5000ms test timeouts listed in design.
