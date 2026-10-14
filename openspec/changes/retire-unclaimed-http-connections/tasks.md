# Tasks

## 1. HTTP ownership correction

- [x] 1.1 Add a deterministic actual-buildApp TCP regression for an acknowledged zero-byte connection and observe bounded close failure before implementation; retain raw command/output and probe cleanup separately from graceful success.
- [x] 1.2 Implement the minimum unclaimed-connection shutdown fence at the HTTP owner; verify cold/incomplete-header/late-accept retirement, admitted partial-body/held-response preservation, and existing upgrade ownership with meaningful unit/integration tests and a real application smoke. Update existing lifecycle documentation with the ownership boundary in the same change.

## 2. Integration and independent acceptance

- [x] 2.1 Replay the unchanged #92 permanent caller-abort/helper-drain regression in an explicitly identified combined archive on giap-vps; require original error preservation, SIGTERM, helper destruction before graceful owner exit, and empty owned inventories without extending its 15s/30s windows.
- [ ] 2.2 Run scoped checks, full local checks and strict fixture validation, then freeze the separate prerequisite head for original full Docker discovery, four-seat independent high-risk review, protected CI and merge. Preserve #92's existing review counters and require its rebased final-head standalone deployment/full-Docker gates afterward.

## Risk and evidence map

- Concurrency/state/resource ownership: acceptance and request-claim barriers, cold/incomplete-header/late-accept cases, closed-socket removal and repeated close; no blanket socket retirement.
- API/integration/backward compatibility: admitted bodies/responses and existing HTTP/upgrade/gateway lifecycle regressions remain unchanged.
- Security/data: no auth guard or credential surface changes; service/activity/database close ordering preserved and actual failure cleanup observed.
- Evidence/operations: semantic TCP RED, real application smoke, exact identities and cleanup, independent review/CI; combined #92 archive is explicitly not a final-head claim.
- Not selected: migrations, dependency changes, provider inference, DSH/image customization, production rollout and Docker DELETE-tail repair. No corresponding behavior is introduced.
