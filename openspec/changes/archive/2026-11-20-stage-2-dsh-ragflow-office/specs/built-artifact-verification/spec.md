## ADDED Requirements

### Requirement: Privileged e2e fixtures leave the reviewed checkout unchanged

Built-artifact verification fixtures that run as root SHALL NOT write files into the repository checkout, including Python bytecode caches beside loaded modules. The e2e fault fixture's worker process SHALL load the private-runtime supervisor with bytecode writing disabled inside that process itself, so the setting survives privilege escalation and environment resetting, without changing the fixture's fault modes, identity checks or cleanup semantics. After a full trusted run the checkout SHALL have no untracked files, so a second custody invocation on the same frozen checkout is admitted.

#### Scenario: Supervisor loaded as a module writes no cache

- **WHEN** the fault fixture worker loads the supervisor through module import as in its fault modes
- **THEN** no `__pycache__` directory or bytecode file appears under the repository `scripts/` directory
- **AND** a Docker-free regression proves this and fails against the version that loads the module with bytecode writing enabled

#### Scenario: Frozen checkout survives a full run

- **WHEN** `pnpm test:docker platform/test/e2e-engine.docker.test.ts` and then a complete custody run finish on a clean trusted checkout
- **THEN** `git ls-files --others --exclude-standard` is empty, `scripts/__pycache__` does not exist, and a second `pnpm --silent verify:docker start <same sha>` on that checkout is admitted

### Requirement: Fixture process capture tolerates genuine exit between reads

When the e2e custody fixture captures the owned process tree, a candidate process whose `/proc` entries disappear between successive reads SHALL be treated as exited only when the read fails with not-found or no-such-process and a fresh birth-identity observation confirms that exact process is absent; such a candidate SHALL be skipped for that observation without failing the capture. A candidate's private-runtime roots and network-namespace verdict SHALL be recorded only after every check for it completed in that observation. A process that is still present SHALL undergo the unchanged authority, ownership and separate-network-namespace checks; a vanished process SHALL never count as having passed them; permission errors and other read failures SHALL still fail; and the final exact launcher and private-Engine count checks SHALL remain unchanged.

#### Scenario: Private Engine exits between argument and namespace reads

- **WHEN** a captured private `dockerd` exits after its command line was read and before its network namespace is read
- **THEN** that observation skips the candidate without a `FileNotFoundError` crash and records none of its roots from that observation
- **AND** the scenario still requires the exact launcher and both private roots to have been verified in some complete observation, failing otherwise

#### Scenario: A present process still fails its checks

- **WHEN** a captured private Engine is still running but shares the caller's network namespace or has mismatched root authority
- **THEN** the capture fails exactly as before

#### Scenario: Non-absence read failures are not exit

- **WHEN** reading a candidate's `/proc` entries fails with a permission error, or fails with not-found while its birth identity is still present
- **THEN** the capture fails rather than skipping the candidate
