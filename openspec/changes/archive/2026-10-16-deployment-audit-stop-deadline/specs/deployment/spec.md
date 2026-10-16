# Deployment verification delta

## ADDED Requirements

### Requirement: Audit verification preserves graceful stop and bounded failure

The deployed audit verification sequence MUST allow an owned platform stop to complete during its requested30s graceful interval without the caller's ordinary15s observation deadline interrupting it. The platform stop caller MUST retain a finite deadline with completion margin. Other observations MUST retain their existing15s deadline. Success MUST still require exact ownership, inspected exit0 and ordered restart. Deadline failure MUST propagate through actual fixture drainage and canonical cleanup, never become acceptance success.

#### Scenario: Graceful completion after the ordinary observation deadline

- **WHEN** the exact owned platform completes its audit stop after15s and before30s
- **THEN** the caller permits completion, verifies exit0, restarts the captured platform and completes the real audit sequence

#### Scenario: Command does not complete within its envelope

- **WHEN** the external platform-stop command exceeds its finite caller deadline
- **THEN** the command fails after child closure, the audit scenario fails without attempting restart, and real fixture cleanup still retires its owned resources
