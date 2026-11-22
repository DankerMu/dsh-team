## Risk packs

- **Concurrency / shared state / ordering — selected.** Restart order and health waits. Each step waits, within a bound, for health before it probes. Tasks 1.1, 1.2.
- **Error handling / rollback / partial outputs — selected.** A failing step must not bypass the deployment fixture's cleanup. The sequence runs inside the existing `withDeployment`, which still owns cleanup. Task 1.1.
- **Auth / permissions / secrets — selected.** This is security-boundary evidence: firewall reach and rules. Outcomes are printed without any secret, and the JWT never reaches argv. Tasks 1.1, 1.3.
- **Documentation / migration notes — selected.** The operator recovery wording follows the lane. Task 2.1.
- **Not selected:** product code, config and release. The orchestrator, compose and script are not changed.

## Acceptance-criteria mapping (#654)

- **AC1** (holder-restart sequence with refused/timeout, same ID, healthy; `up -d` unchanged; DS restart restores `[answered, timeout]` for both instances) → 1.1, 1.2.
- **AC2** (VPS exact-head evidence; docs corrected if contradicted) → 2.1, 2.2.
- **AC3** (exact `ip6tables -S INPUT` readback) → 0.1 (VPS measurement), 1.3.
- **AC4** (IPv6 behaviour probe) → not met here. 0.1 shows the daemon supports IPv6 networks, so the probe is the second change under #654. The PR says `Refs #654`.
- **AC5** (no orchestrator change; no lengthened deadline; no weakened assertion; every new wait bounded) → must preserve, 1.4.

## Must preserve

- Every existing `deployment.docker.test.ts` assertion and its order: the identity checks, the publications, socket isolation and the initial `firewallReach`.
- `deploy/compose.yml`, `deploy/document-server-net.sh` and `platform/src/orchestrator/` unchanged.
- The deployment fixture's resource registration and cleanup: no new resources, only restarts of this run's own containers.
- `deliveredHealthcheck` and `healthyWithinStartPeriod` are moved, not duplicated, and their current caller keeps passing.
- The 800-line and complexity limits.

## 0. Pre-implementation measurement

- [x] 0.1 Measured on giap-vps on 2026-11-21: Docker 29.1.3, kernel 6.8.0-117-generic, `net.ipv6.conf.all.disable_ipv6=0`. The probe was a holder-like `dsh-team-v6probe` container: the platform image's runtime layer, `node:24.13.1-bookworm-slim` plus `iptables`, built for linux/amd64, running `deploy/document-server-net.sh` as root with `NET_ADMIN`.
  - (a) `/proc/net/if_inet6` exists, and the ready marker was written.
  - (b) `ip6tables -S INPUT` printed exactly the proposal's five lines, the same as the arm64 measurement.
  - (c) `docker network create --ipv6 dsh-team-v6probe-net` succeeded with `EnableIPv6: true` and an automatic ULA `/64`.

  The container, network and image were removed afterwards. No `dsh-team` container, network or image remained.

  **Consequence for AC4:** the daemon supports IPv6, so this change does not meet AC4. The PR says `Refs #654`. The IPv6 behaviour probe follows as a second change under #654, which stays open until that change merges.

- [x] 0.2 The case's timeout of `900_000 + 1_380_000` ms fits every runner that executes it.
  - **CI-VPS path only:** the 1850 s host-observation deadline and `RuntimeMaxSec=1800` (`scripts/ci-vps-owner.mjs:116,305`) apply there, and that path runs `ci:model` (`scripts/ci-vps-run.mjs:14`).
  - **Trusted lane:** `pnpm test:deploy` runs as its own systemd unit, bounded only by vitest.
  - **Custody:** ordinary `verify:docker` custody runs the full `pnpm test:docker` (`vitest run --project docker`, discovery `platform/test/**/*.docker.test.ts`). That includes this case, so the restart sequence runs there too. The worst case adds about 23 minutes to the suite. `trusted-docker-owner.mjs:69` bounds only launch observation and sets no overall deadline.

  Recorded by the orchestrator on 2026-11-21.

## 1. Implementation

- [ ] 1.1 Add a holder-restart sequence helper to `document-server-net-fixture.ts`, called from `deployment.docker.test.ts` after the initial reach. Steps:
  - restart the holder and wait for it to be healthy (bounded);
  - assert the same ID and the DS `NetworkMode`;
  - assert `firewallReach` `{inside: [refused, refused], outside: [refused, timeout]}` for both instances;
  - record the holder `MacAddress` before and after;
  - run `[...deployment.compose, 'up', '-d', '--no-build', '--pull', 'never']`, then assert that `Id` and `State.StartedAt` of `expectedIds` are unchanged and the reach is unchanged;
  - restart the DS and wait for it to be healthy (bounded);
  - assert `firewallReach` is back to the original outcomes for both instances.
- [ ] 1.2 Move `deliveredHealthcheck` (parameterised by compose service) and `healthyWithinStartPeriod` (parameterised by container name) into `document-server-net-fixture.ts`. Rewrite them Vitest-free against `AsyncDockerCommand`/`DockerOutput` and `docker-cleanup.ts`, throwing instead of using `expect`, and update the caller at `deployment-document-server.docker.test.ts:108-110`. The holder and Document Server waits are two call sites of the same function, each bounded by its delivered `start_period`.
- [ ] 1.3 Not started if 0.1(a) shows no `if_inet6` on giap-vps: AC3 cannot be met as written, so the owner decides. Otherwise add the IPv6 readback, one exec each time (`sh -c 'test -e /proc/net/if_inet6 && ip6tables -S INPUT'`), run before and after the holder restart: `if_inet6` exists in the holder, and `ip6tables -S INPUT` equals the named exact list from 0.1.
- [ ] 1.4 Add the case's own timeout `900_000 + 1_380_000`, with the itemised comment from design.md § Budget. Sibling unit or integration tests cover any new pure helper (outcome parsing, readback comparison).

## 2. Verification and docs

- [ ] 2.1 Docs:
  - `docs/DEPLOY.md:122` and `deploy/README.md:13` cite the lane;
  - the README's "not probed" sentence is updated;
  - `deploy/README.md` § Evidence required: Compose deployment gains the sequence and the readback;
  - any wording the VPS run contradicts is corrected.
- [ ] 2.2 Exact-head trusted VPS `pnpm test:deploy` + `pnpm test:docker` with confirmed cleanup, with the sequence's outcomes in the PR. Run `pnpm check`.
