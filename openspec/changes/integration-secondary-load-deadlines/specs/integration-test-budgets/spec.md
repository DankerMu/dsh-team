## ADDED Requirements

### Requirement: Secondary-table integration cases declare measured budgets and name their stalls

The browser-exec, login-throttle, ragflow-proxy-auth and gateway-websocket integration cases SHALL each run under a declared, named case budget, never vitest's implicit default. Each budget's comment SHALL state its measured basis.

Each of the following waits SHALL end strictly before the case budget, so that a stall fails with an error naming the stalled step, not with the runner's timeout: synchronous children, the browser client timer, each fetch or HTTP request, and each HTTP peer observation. The remaining waits (listener start and close, in-process hashing, directory removal) are covered by the measured budget.

#### Scenario: A browser client hangs

- **WHEN** a browser-exec case's client never exits
- **THEN** the client timer fails the case with `Owned browser protocol client timeout` before the case budget ends

#### Scenario: A browser-exec registration child stalls

- **WHEN** the audit registration child of a browser-exec case does not exit
- **THEN** it is killed at the case deadline, and the failure names the registration phase

#### Scenario: A login or a proxy request stalls

- **WHEN** one login in a throttle case, or one rejection's proxy request, never answers
- **THEN** the case fails naming that attempt or that rejection label before its budget ends

#### Scenario: A websocket peer stalls

- **WHEN** an HTTP peer observation in a websocket case never settles
- **THEN** the observation fails with its own error before the case budget ends
