## ADDED Requirements

### Requirement: Verified absence is distinct from exceptional startup failure

The instance service SHALL retain an identity-fenced routing exclusion after the owner verifies that the exact indexed container is absent against the unchanged account and instance row. An ordinary replacement admission refusal SHALL NOT become an exceptional startup failure when its flight settles. The exclusion SHALL NOT disappear merely because a caller retries.

#### Scenario: Replacement is refused by current capacity

- **GIVEN** A and B are running and the administrator reduces capacity from two to one without evicting either instance
- **WHEN** A's exact indexed container is absent and A requests startup while B occupies the remaining slot
- **THEN** startup returns HTTP200 with status and reason full, and subsequent status observations return the same ordinary HTTP200 full state
- **AND** non-navigation HTTP and WebSocket gateway requests return503 with reason full, HTML navigation redirects to the existing waiting page, and no request reaches A's obsolete endpoint
- **AND** B's persisted identity, endpoint and routing remain unchanged

#### Scenario: Observations use live admission settings

- **GIVEN** a settled capacity refusal and a matching verified-absence exclusion
- **WHEN** current model settings become incomplete or current capacity becomes available
- **THEN** observations project unconfigured or stopped respectively using current canonical settings, without routing to the obsolete endpoint or caching the previous full result

#### Scenario: Explicit retry acquires a replacement identity

- **GIVEN** A's obsolete identity remains excluded after capacity refusal
- **WHEN** B releases capacity and A explicitly retries successfully
- **THEN** the service starts and readies a different container identity and routes only its complete current endpoint and credential
- **AND** the obsolete container identity, endpoint and credential are not reused by the replacement

#### Scenario: Actual failures retain exceptional classification

- **GIVEN** a verified-absent identity whose replacement encounters an unexpected failure without a durable error transition
- **WHEN** the matching identity is observed after the failed flight
- **THEN** status returns the existing sanitized500 and the gateway returns the existing sanitized502 instead of an ordinary admission state
- **AND** a generic inspection failure alone does not invalidate an otherwise healthy running identity, and a different trusted current identity is not poisoned by the old failure receipt
