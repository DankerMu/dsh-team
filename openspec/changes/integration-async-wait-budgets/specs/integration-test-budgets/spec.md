## ADDED Requirements

### Requirement: Asynchronous inner waits fit inside an explicit case budget and fail attributably

These cases SHALL each declare an explicit case budget:

- the egress-capture refusal cases;
- the chrome-start receipt-fault case;
- the instance readiness-failure cases;
- the firewall holder script cases.

Every inner wait in them SHALL have a deadline strictly below the case timeout. The deadline is either derived from the case budget, or is a named constant whose relation to the budget is stated.

When an inner wait times out, the failure SHALL name the phase and the elapsed milliseconds, and SHALL add per site:

- egress-capture: whether the awaited capture process is alive;
- chrome-start: whether the spawned child is alive;
- instance: the poll count and the observed instance status;
- holder: which phase timed out.

A wait made of two phases SHALL give each phase its own deadline.

#### Scenario: An inner wait outlives the case budget

- **WHEN** an egress-capture refusal case's capture never starts listening
- **THEN** the case fails before its budget expires with the phase, the elapsed time and the capture process's liveness, not with a bare runner timeout

#### Scenario: A slow first phase does not starve the second

- **WHEN** the holder script's ready marker arrives late but within its own deadline
- **THEN** the exit wait after SIGTERM still gets its full deadline, and the case reports no timeout
