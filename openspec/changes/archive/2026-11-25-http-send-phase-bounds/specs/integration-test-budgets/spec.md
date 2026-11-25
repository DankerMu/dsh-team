## ADDED Requirements

### Requirement: The shared HTTP helpers fail a stalled send or observation before the default case budget, naming the stall

The shared integration helper that sends one HTTP request SHALL, by default, bound each send, its close wait included, below vitest's default case budget, with a named bound that states its measured basis. A caller with a far larger case budget MAY pass a larger named bound. When the bound or the caller's signal aborts a send, the failure SHALL name the method, the path and the phase (response headers or response body), and keep the original error as its cause. Other request errors SHALL pass through unchanged. A stalled close wait SHALL fail naming the close phase without hiding an earlier send failure. The shared peer-observation helper SHALL accept a label and include it in its failure.

#### Scenario: A peer never answers a send

- **WHEN** an integration case sends a request to a peer that never answers, under the default case budget
- **THEN** the send fails before the case budget ends, naming the request and the `response headers` phase

#### Scenario: A peer sends headers and then stalls

- **WHEN** the peer answers with headers but never ends the body
- **THEN** the send fails naming the `response body` phase

#### Scenario: A labelled observation stalls

- **WHEN** a labelled peer observation never settles
- **THEN** the failure carries that label
