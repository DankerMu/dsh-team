# Design

## Context

- **Holder.** Runs the platform image as root with only `NET_ADMIN`, from `deploy/document-server-net.sh`. Its ready marker is on tmpfs, so a restart rewrites it. Healthcheck: `test -f /run/dsh-team/firewall-ready`, with `start_period` 30 s and `start_interval` 1 s (`deploy/compose.yml:74`).
- **Document Server.** Uses `network_mode: service:documentserver-net` and `depends_on … restart: true`, with no restart policy.
  - The deploy stand-in listens on 80 and 8000, then `exec xargs tail -F` (`deployment-compose-fixture.ts:83-87`).
  - It becomes healthy through the inherited #648 healthcheck, which has a 300 s `start_period` (`deploy/compose.yml:107`; `deployment-document-server.docker.test.ts:106-110`).
  - PID 1 is `xargs`, which ignores SIGTERM, so `docker restart` waits out its 10 s grace before SIGKILL.
- **Instance attachment.** The orchestrator connects the holder to each instance network with the static `IPAMConfig.IPv4Address` +4 (`platform/src/orchestrator/networks.ts:648-649`). `container-document-server.docker.test.ts:263-266` shows the holder keeps +4 across a stop/start.
- **Fixture constraint.** `document-server-net-fixture.ts` must stay Vitest-free. `deployment-fixture.ts` imports it, and the lock-contention child loads that file under plain node (`deployment.docker.test.ts:62-108`).

## Decisions

- **One sequence in the existing deployment, after the initial reach.**
  - It reuses the case's `lifecycle.commandAsync` with its 30 s per-call bound and registers no new resources.
  - It only restarts this run's own containers, so the existing registration, absence checks and custody cleanup still cover everything.
  - `docker restart` is already classified as a mutating submission (`scripts/docker-command.mjs:20-28`).
- **Expected outcomes.** The namespace behaviour comes from #624's one-off measurement: the holder gets a new namespace while the Document Server stays in the old one, `up -d` does nothing, and a Document Server restart rejoins. The reach outcomes below are inferred from the rules, not measured.

  | Moment                            | `inside` (holder ns, loopback 80/8000)                   | `outside` (instance → +4:80/8000)                                       |
  | --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
  | After the holder restart          | `[refused, refused]` (the new namespace has no listener) | `[refused, timeout]` (TCP 80 is accepted and then RST; 8000 is dropped) |
  | After `up -d`                     | `[refused, refused]`                                     | `[refused, timeout]`                                                    |
  | After the Document Server restart | `[answered, answered]`                                   | `[answered, timeout]`                                                   |
  - The holder ID and the Document Server's `NetworkMode` (`container:<same id>`) are asserted unchanged after the holder restart. That they still pass is the point: the identity checks alone cannot detect a trapped Document Server.
  - The holder `MacAddress` on each instance network is recorded before and after, for diagnosis.
  - If the lane observes anything else, it fails and shows the outcomes. The PR reports the difference, and the docs are corrected from the observation. The expectation is never relaxed.

- **`up -d`.** The command is `[...deployment.compose, 'up', '-d', '--no-build', '--pull', 'never']`, exactly as `deployment-fixture.ts:144,166` runs it. Before and after, the case compares `Id` and `State.StartedAt` for its `expectedIds`: platform, holder, Document Server and the two instances.
- **Bounded health waits, Vitest-free.** `deliveredHealthcheck` and `healthyWithinStartPeriod` move from `deployment-document-server.docker.test.ts` into `document-server-net-fixture.ts`. They are rewritten against `AsyncDockerCommand`/`DockerOutput` and `docker-cleanup.ts`'s `containerDocument`/`record`, and throw instead of using `expect`.
  - Both are parameterised: by compose service (`documentserver-net`/`documentserver`), and by container name.
  - The holder wait and the Document Server wait are two call sites of the same function, each bounded by its delivered `start_period`.
  - The existing caller at `deployment-document-server.docker.test.ts:108-110` switches to the moved functions.
- **IPv6 readback.** The expected lines are a named exact list, taken from the VPS measurement in task 0.1 with the platform image. The arm64 Docker Desktop measurement on 2026-11-21 matches the proposal's list; if the VPS output differs, the VPS output wins and the difference is reported.
  - The holder must have `/proc/net/if_inet6`. If 0.1(a) shows giap-vps has none, implementation of the readback (task 1.3) does not start and the owner decides, because AC3 cannot be met as written.
  - The readback also runs in the new namespace after the holder restart.
- **Budget.** The case has no explicit timeout, so it uses the docker project's 900 000 ms default (`vitest.config.ts:26-32`). This change adds the case's own timeout of `900_000 + 1_380_000`, itemised in a comment beside `it(...)` (precedent: `vitest.config.ts:51-83`).
  - Three `firewallReach` rounds × two instances × (1 inspect + 2 execs) × 30 s = 540 s.
  - The `expectedIds` inspections before and after `up -d`: 5 × 2 × 30 s = 300 s.
  - Two restarts + `up -d`: 3 × 30 s = 90 s.
  - The holder health wait: 30 s + its last 30 s inspect = 60 s.
  - The Document Server health wait: 300 s + its last 30 s inspect = 330 s.
  - Two readback execs, 2 × 30 s = 60 s, which makes the total 1 380 s. Each readback is a single exec: `sh -c 'test -e /proc/net/if_inet6 && ip6tables -S INPUT'`.
  - No extra inspects are needed. The MAC from before the restart comes from the existing `holder` inspect (`deployment.docker.test.ts:571`). The MAC from after the restart, and the identity assertions (holder ID, Document Server `NetworkMode`), come from the pre-`up -d` round of `expectedIds` inspects already counted above.
  - AC5's "no lengthened deadline" refers to existing per-step bounds, and none changes. This is a new budget for new steps.
  - The orchestrator confirms that the custody envelope (`scripts/README.md:114`) accommodates the longer case before implementation (task 0.2).

## Review focus

- The `inside` expectations.
- The Vitest-free move.
- The budget sum against the custody envelope.
- The AC4 branch.
- That no failure path bypasses `withDeployment`'s cleanup.

## Non-goals

- No change to the topology, compose, the holder script or the orchestrator.
- No `test:stack` real Document Server rejoin.
- No IPv6 behaviour probe in this change (see AC4).

## Sibling surfaces

- `deployment-document-server.docker.test.ts:108-110` is the existing caller of the moved waits.
- The lock-contention child loads the fixture through `deployment-fixture.ts`.
- `platform-stack.stack.test.ts:531` calls `commandReach`: the same fixture and the same `firewallReach` semantics, unchanged.
