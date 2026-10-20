## ADDED Requirements

### Requirement: Platform UI verification retains its public listener continuously

Platform UI verification SHALL retain unique invocation-owned listener custody continuously from choosing its public Origin until teardown. App/database construction and backend readiness SHALL NOT release and later rebind that public port. Real compiled assets, HTTP, SQLite, authentication, source-address and Origin policy, existing browser failure observers and current full UI discovery SHALL remain unchanged. Verification SHALL NOT rely on listen retries, fixed shared ports, increased deadlines or tolerated request failures.

#### Scenario: Another listener competes during initialization

- **WHEN** initialization is deliberately held after the public Origin is selected and an independent listener attempts to bind that exact address
- **THEN** the competing bind fails because the fixture continuously owns the listener, and initialization can subsequently serve real platform requests without rebinding the public port

#### Scenario: Browser requests reach the ready platform

- **WHEN** the fixture admits consumers after the real application becomes ready
- **THEN** the configured public Origin equals the continuously owned public endpoint, real same-Origin authentication/mutation succeeds, and a wrong-Origin mutation remains rejected
- **AND** raw HTTP/WebSocket bytes, cookies, backpressure and orderly stream closure retain the existing browser verification guarantees

#### Scenario: A connection arrives before readiness

- **WHEN** a socket reaches the owned public listener before backend activation
- **THEN** it is closed as an owned pre-ready connection without buffering, forwarding to an unready destination or releasing the listener

### Requirement: UI fixture teardown preserves failures and unrelated listeners

Normal completion, initialization failure and scenario failure SHALL settle every acquired invocation-owned listener, paired socket, API context and database/application resource while preserving unrelated listeners. The public listener SHALL reject activation after closure and SHALL NOT switch destinations after activation. Cleanup SHALL attempt independent owned resources even if an earlier cleanup fails, preserve the original scenario failure alongside cleanup failures and retain private paths when settlement is unconfirmed. Playwright browser/page ownership SHALL remain unchanged.

#### Scenario: Initialization or the scenario fails

- **WHEN** initialization fails after owned resources exist or the fixture callback throws
- **THEN** the original failure remains visible, owned ports become reusable only after teardown, acquired database handles are closed, and an unrelated listener remains usable

#### Scenario: Forwarding authority is changed after activation or closure

- **WHEN** a caller attempts a second destination activation or attempts activation after teardown begins
- **THEN** verification refuses the transition without reopening a listener or forwarding to the replacement destination

#### Scenario: Cleanup itself fails

- **WHEN** one owned cleanup operation fails after the scenario has failed
- **THEN** remaining independent cleanup is attempted, both failures are retained and unconfirmed resources are not reported as successfully retired
