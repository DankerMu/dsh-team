# Design

Change only AuditSequence.run's optional millisecond deadline, its platform stop invocation, and the sole privacy callback that supplies the15s default. Platform stop uses45s, preserving requested30s Docker grace plus completion/transport margin. All other commands retain15s; Docker command timer/closure mechanism and production lifecycle are unchanged.

Invariant: the caller does not interrupt a platform that exits normally during its requested grace, while an overdue external command still rejects and canonical fixture cleanup completes.

## Required proof

Exercise the real verifyDeployedCredentialPrivacy sequence on trusted giap-vps. A separate Docker regression decorates only the existing external lifecycle boundary, retaining real HTTP, SQLite, Docker, audit, exit inspection and restart.

- Slow stop: independently verify captured platform immutable ID/name/run label, send SIGSTOP only to that owned platform, issue the actual stop30s, and send SIGCONT after20s. Always settle the continuation before leaving the decorated call, including old15s caller failure. Require successful stop after15 and before30 seconds, real exit0 readback, subsequent restart, complete audit acceptance and captured platform absence after cleanup. Original callback must fail for this exact stop, not setup.
- Overdue command: replace only that captured platform stop's external executable with an owned hanging Node child, keeping actual docker-command timers, signals, streams and close settlement. Require deadline failure, child SIGKILL closure, no restart, propagated audit-error-retirement failure and real deployment cleanup/owned platform absence. Ordinary Docker execution and all cleanup commands remain real.
- The original unmodified deployment suite and complete Docker discovery remain mandatory on the frozen candidate; independent resource/unit inventories must be empty.

No mocked deadline-number assertions or source-text tests. The added Docker test verifies outcomes; command process interception follows existing docker-version integration-test convention. Fault controls must never target an unverified discovery, change shared Docker configuration or suppress original errors. Parent-owned runtime and exact-head publication only.

Rollback: revert test-only callback/deadline/regression together. No data migration or production rollback needed.
