## ADDED Requirements

### Requirement: Synchronous child waits fit inside an explicit case budget and fail attributably

An integration case that declares a case budget and runs a synchronous child process SHALL bound that child by the budget. The browser-build, CI VPS proxy and profile-seed suites, and the trusted-Docker audit dispatch and writer cases, SHALL declare such a budget instead of inheriting the runner default. Each bounded child's timeout SHALL be cut from the case's remaining budget at the moment of the spawn, minus a stated reserve, and SHALL be enforced with an uncatchable signal, so that it expires before the case budget. When the cut fires, the failure SHALL name the phase and the elapsed milliseconds, and SHALL report any descendant the suite records that is still alive (or that descendants are not observed), without child output, environment values or paths.

#### Scenario: A synchronous child outlives the case budget

- **WHEN** a covered case's synchronous child would run longer than the case budget allows
- **THEN** the child is killed before the budget expires and the case fails with the phase and the elapsed time, not with a bare runner timeout
