# Spec Delta

## ADDED Requirements

### Requirement: Drain completed keep-alive connections during shutdown

The platform SHALL retire a keep-alive HTTP connection after all its admitted requests and responses settle during graceful shutdown. The peer SHALL receive complete ordered response bytes before orderly closure. The platform SHALL NOT require the peer to close an otherwise idle connection or wait for an inactivity timeout to finish shutdown. Existing gateway transport retirement and service, activity and database settlement ordering SHALL remain unchanged.

#### Scenario: Request body completes after shutdown begins

- **WHEN** a keep-alive request has admitted headers and an incomplete body at shutdown, and the peer then completes its body
- **THEN** its normal handler and complete response settle, the peer observes connection closure, and application shutdown completes without client-initiated disconnect

#### Scenario: Response work completes after shutdown begins

- **WHEN** a keep-alive response is held by admitted application work across shutdown
- **THEN** release of that work permits its complete response and subsequent connection/application closure

#### Scenario: Multiple admitted requests share one connection

- **WHEN** two pipelined requests were admitted on one connection and the first response finishes while the second still has pending response work during shutdown
- **THEN** the first completion does not close the connection prematurely, both complete responses arrive in order, and closure follows the last response

#### Scenario: A peer applies response backpressure

- **WHEN** a peer temporarily stops reading an admitted response while shutdown begins and subsequently resumes reading
- **THEN** all accepted response bytes arrive intact before orderly closure and shutdown settlement

#### Scenario: A peer cancels admitted responses

- **WHEN** a peer disconnects with admitted requests or responses pending during shutdown
- **THEN** transport ownership releases without preventing the existing application and lifecycle work from settling or retaining application shutdown
