## Implementation and evidence

- [x] 1. Capture real-verifier subprocess RED for failed image admission, terminal receipt, canary exclusion, no second build and no test child.
- [x] 2. Reuse one canonical Docker build diagnostic projection; migrate the existing caller without changing its output contract, limits or error privacy.
- [x] 3. Persist failed admission and distinct cleanup outcomes; prove unknown/foreign/changed identities cannot delete, verified owned cleanup remains exact and failed/blocked cleanup stays explicit.
- [x] 4. Prove build-success qualification failure and evidence-publication failure remain distinct, private and nonzero; audit current image-receipt consumers.
- [x] 5. Exercise actual entrypoint smoke and canonical checks; update existing operator guidance, complete four-seat review, exact-head trusted Compose/full Docker, independent cleanup/fence and protected CI/merge/archive.

## Risk mapping

- CLI/script entry and config:1,3–5; root command stays canonical, no new configuration or model authorization.
- File IO/path/schema:1,3–4; atomic private receipt publication, immutable identity and exact-target ownership; no path expansion.
- Auth/secrets:1–4; output and exception canaries, existing safe projection, no raw output or proxy values.
- Concurrency/state/partial outputs:1,3–4; submitted versus failed build, qualification boundary, unconfirmed/blocked/failed cleanup and durable publication.
- Resource limits/discovery:1–5; unchanged600s/16MiB build limits, no retry or additional discovery, bounded safe metadata.
- Compatibility/release:2,4–5; existing Docker-command consumers, model rescue and wrapper fixture audited; full Docker dependency closure checked.
- Documentation:5; diagnostics and unknown historical cause explicitly separated; human acceptance remains deferred.
- Database/business API/production image migration: not selected; outside this change.
