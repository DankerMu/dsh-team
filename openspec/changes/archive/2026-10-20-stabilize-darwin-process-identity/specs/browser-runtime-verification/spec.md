## ADDED Requirements

### Requirement: Process generation authority is independent of observer display and executable presentation

Verification process ownership SHALL identify the same live process generation independently of observer locale, timezone, command display and an executable transition within that generation. Identity SHALL include kernel generation evidence sufficiently precise to distinguish process births; PID alone, second-resolution start display and repeated display stability SHALL NOT authorize cleanup. Missing prerequisites, permission failures, malformed observations and unknown states SHALL fail closed. Existing Linux kernel-start and zombie/absence semantics SHALL remain unchanged.

#### Scenario: An owned process changes executable or command presentation

- **WHEN** a still-live invocation-owned process changes its executable or command presentation after its birth identity is captured
- **THEN** observers retain the same generation identity without a delay or recapture workaround, and different live process generations remain distinguishable

#### Scenario: Observers use different display environments

- **WHEN** observers query the same owned live process using different locale and timezone settings
- **THEN** they obtain the same generation identity and preserve an unrelated live sentinel

#### Scenario: Current identity cannot be established

- **WHEN** the kernel observation is unavailable, denied, malformed or has an unsupported process state
- **THEN** verification reports unknown identity and does not signal a guessed process or authorize resource cleanup from supposed owner absence

### Requirement: Obsolete Darwin receipt identity cannot authorize cleanup

A persisted Darwin display-hash process identity from the previous representation SHALL be rejected as unsupported authority before any comparison can establish owner absence, PID reuse, producer settlement or cleanup permission. Verification SHALL preserve the receipt and associated private resources on this refusal. It SHALL NOT translate, overwrite or adopt the old identity using a current PID observation. This restriction SHALL apply to drivers, acquisition producers and external native process ownership, without weakening issued in-memory child ownership or existing immutable resource checks.

#### Scenario: A live driver has a pre-change receipt

- **WHEN** external rescue reads a pre-change Darwin identity for a still-live driver
- **THEN** it refuses before process signalling or resource retirement, retains the receipt and leaves both the driver and unrelated sentinel untouched

#### Scenario: A producer has an obsolete identity

- **WHEN** a receipt contains a pre-change Darwin acquisition-producer identity
- **THEN** rescue cannot treat the representation mismatch as settled production or authorize dependent resource removal
