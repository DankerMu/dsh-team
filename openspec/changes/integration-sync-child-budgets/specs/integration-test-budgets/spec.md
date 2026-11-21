## ADDED Requirements

### Requirement: Synchronous child waits fit inside an explicit case budget and fail attributably

The browser-build and CI VPS proxy suites, the profile-seed filesystem-observer cases, and the trusted-Docker audit dispatch case and the five audit cases whose writer runs through the case-budgeted spawn SHALL each declare an explicit case budget instead of inheriting the runner default, and SHALL run their synchronous children bounded by it. Each such child's timeout SHALL be cut from the case's remaining budget at the moment of the spawn, minus a stated reserve, and SHALL be enforced with an uncatchable signal, so that it expires before the case budget. When the cut fires, the failure SHALL name the phase and the elapsed milliseconds, and SHALL report any descendant the suite records that is still alive (or that descendants are not observed), without child output, environment values or paths.

#### Scenario: A synchronous child outlives the case budget

- **WHEN** a covered case's synchronous child would run longer than the case budget allows
- **THEN** the child is killed before the budget expires and the case fails with the phase and the elapsed time, not with a bare runner timeout
