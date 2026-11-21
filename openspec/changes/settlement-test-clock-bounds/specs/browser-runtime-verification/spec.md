## ADDED Requirements

### Requirement: Wrapper cleanup waits for registered browser drivers

The helper that awaits registered browser drivers before wrapper cleanup MUST NOT return `settled: true` from a poll in which any readable registration of kind `docker-isolated-network` whose receipt pointer `state` is not `stopped` names a driver other than the waiting process whose live (non-zombie, non-exited) process birth matches the registered birth. Registrations that are unreadable, or whose driver cannot be observed, MUST NOT hold the wait; they remain with rescue, which fails closed. The helper returns `settled: false` no earlier than its limit, measured from its own start on its own monotonic clock, at the first poll at or after that limit; it promises neither a minimum wait nor prompt return at the limit. Neither result grants or withholds cleanup.

#### Scenario: Registered driver still running

- **WHEN** a registered isolated-network driver process is alive with a matching birth and a `running` receipt pointer, remains observable, and the helper is awaited
- **THEN** the helper returns only after the driver has exited (or is a zombie) or its pointer `state` reads `stopped`, or with `settled: false` no earlier than its limit

#### Scenario: Registration that cannot own relays

- **WHEN** a registration is not isolated-network, names the waiting process, has a mismatched birth, is already `stopped`, or is unreadable or unobservable
- **THEN** it does not hold the wait
