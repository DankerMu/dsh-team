# http-shutdown Specification

## Purpose

Provide graceful platform HTTP shutdown that cannot be retained by connections without admitted requests, while preserving already-admitted work and existing authenticated gateway transport ownership.

## Requirements

### Requirement: Retire accepted connections without an admitted request

The platform SHALL close its accepted TCP connections that have not submitted complete HTTP request headers when shutdown begins. A connection racing the shutdown fence SHALL NOT retain application shutdown. This behavior SHALL NOT depend on identifying a particular client library.

#### Scenario: Accepted connection sends no request bytes

- **WHEN** a peer has an acknowledged TCP connection, has sent no HTTP bytes, and platform shutdown begins
- **THEN** the peer observes closure and platform shutdown settles without requiring the peer to disconnect or send a request

#### Scenario: Accepted connection has incomplete headers

- **WHEN** a peer has sent only incomplete request headers before shutdown begins
- **THEN** that unadmitted connection closes rather than retaining shutdown

#### Scenario: Connection arrives during shutdown

- **WHEN** another connection is accepted after the shutdown fence but before the listener finishes closing
- **THEN** it closes without admitting work or retaining shutdown

### Requirement: Preserve admitted HTTP and gateway ownership

The platform SHALL preserve normal settlement of HTTP requests whose complete headers were admitted before shutdown, including incomplete request bodies and held response work. Upgraded transports SHALL retain existing gateway retirement semantics. Service work, activity persistence and database closure SHALL retain their existing ordering.

#### Scenario: Admitted request body completes during shutdown

- **WHEN** complete headers were admitted, the body is incomplete, and shutdown begins before the peer supplies the remaining body
- **THEN** the request can complete through its existing handler and response contract without being destroyed as an unclaimed connection

#### Scenario: Admitted response is held across shutdown

- **WHEN** an admitted handler is waiting for application work and shutdown begins
- **THEN** its ordinary response completes after the work settles, and shutdown subsequently settles

#### Scenario: Existing authenticated upgrade closes

- **WHEN** an authenticated gateway connection is upgraded before application shutdown
- **THEN** the existing gateway owner retires the transport with its original settlement and activity guarantees

#### Scenario: Aborted start caller leaves a cold connection

- **WHEN** an instance-start caller disconnects while admitted lifecycle work is running and an unclaimed TCP connection remains when platform shutdown begins
- **THEN** the exact lifecycle helper retires before the platform exits gracefully, the original caller failure remains observable, and no unclaimed connection retains shutdown
