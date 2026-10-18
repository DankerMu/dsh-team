# Tasks

## 1. Characterize the real race and ownership boundary

- [x] 1.1 Add the held-real-startup regression using the existing actual DockerClient/lifecycle fixture; observe semantic RED on the previous shared-Engine command, preserving exact bridge identity and owned cleanup evidence.
- [x] 1.2 Qualify PID/mount/network containment and stdin-EOF ownership on trusted Linux with real namespace/process observations, including supervisor death; store/process qualification alone is not kernel noninterference evidence.
- [x] 1.3 Add an actual-e2e default-bridge preservation regression inside a disposable caller network namespace; observe semantic RED without exposing the host, then GREEN plus real-host bridge identity preservation before/after actual e2e.

## 2. Cut over the built verification command

- [x] 2.1 Implement the invocation-owned private Docker/containerd supervisor and the public e2e entry cutover; verify actual e2e retains health, exact schema/ledger and all HTTP smoke assertions, and the held startup regression becomes GREEN.
- [x] 2.2 Cover missing process/network/executable prerequisites, private identity rejection, setup/partial daemon failures and cancellation/parent-loss paths with real subprocess checks; assert no daemon/main admission on failed network isolation, exact owned process retirement and unrelated sentinel preservation.
- [x] 2.3 Update existing command/prerequisite documentation and any necessary CI setup without changing dev-server semantics; verify documented root commands and record Linux-only e2e compatibility in the PR.

## 3. Integration acceptance

- [x] 3.1 Run scoped lint/type/integration gates and strict OpenSpec validation; record commands, exits and residual limits.
- [x] 3.2 Freeze and independently review the complete candidate with correctness, test-evidence/spec and security/resource seats; adjudicate through the bounded fix gate.
- [x] 3.3 Run actual e2e and original full Docker discovery on the reviewed trusted Linux candidate, independently inventory owned resources and unchanged host bridge/daemon/unrelated-workload identities, publish exact-head evidence and require protected CI before merge. Never use Docker BuildKit history queries to investigate failures on the shared host.

## Risk-pack mapping

- Selected: Public API / CLI / script entry — tasks2.1–2.2 prove public command success/refusal.
- Selected: Config / project setup — tasks1.2,2.2–2.3 prove Linux/sudo/namespace prerequisites; no shared fallback.
- Selected: File IO / path safety / overwrite — tasks2.1–2.2 prove captured-root cleanup and retained failure evidence.
- Not selected: Schema / columns / units / field names — no format changes; existing exact ledger acceptance remains under2.1.
- Selected: Auth / permissions / secrets — tasks2.1–2.2,3.2 prove nonroot scenario, narrow environment and privileged cleanup authority.
- Selected: Concurrency / shared state / ordering — tasks1.1–1.3,2.1–2.2 prove real held-start independence, kernel network separation and process ownership ordering.
- Selected: Resource limits / large input / discovery — tasks1.2,2.2 prove bounded startup/settlement and contained descendants, not broader resource discovery.
- Selected: Legacy compatibility / examples — task2.3 records Linux-only change;2.1 preserves all built acceptance.
- Selected: Error handling / rollback / partial outputs — tasks1.2,2.2 cover partial startup, EOF, supervisor death and failure propagation.
- Not selected: Release / packaging / dependency compatibility — no production packaging or npm dependency changes; installed runtime compatibility is checked by1.2 and3.3.
- Selected: Documentation / migration notes — task2.3 updates existing command guidance.

Fixture admission is parent-inline under the higher-priority prohibition on lone mapped-slice delegation. Independent full-diff review remains batched. No production reconciliation, dev-server behavior, provider calls or host service configuration changes are authorized by this fixture.

Completion: PR264 merged after exact reviewed `837220a627c9b5e356e1558deee47fb0b349ef26` passed targeted13/13, standalone Compose11/11 and original full Docker104/104 across32files. Each command's independent owned inventories were empty and the original four workloads, daemon PID and default bridge unchanged. Required CI39094854791, local `pnpm check:fast` and strict fixture validation passed. Runtime evidence: https://github.com/DankerMu/dsh-team/pull/264#issuecomment-6245610017 . Exact rule-file human approval: https://github.com/DankerMu/dsh-team/pull/264#issuecomment-6245553118 .

Review history is retained, not reset: round5 identified two fault-oracle P1s after the original two fix passes; the user authorized one additional bounded pass. Independent outer test containment, phase-specific actual-process observations and unrelated-error rejection closed both. A duplicated P2 second-pass observation race was reproduced with a real transient and removed by reusing captured daemon identities. Four-seat review plus disclosed parent-inline small closure produced round6 clean. Initial inconclusive experiments and separately authorized exact-path recovery are not acceptance evidence; no provider calls, deadline relaxation, skipped original discovery or host maintenance occurred in final acceptance.
