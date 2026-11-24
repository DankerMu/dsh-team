# Holder restart and IPv6 readback in the deploy lane

## Why

The bundled Document Server (DS) joins the network namespace of its firewall holder `dsh-team-documentserver-net` (#624, PR #633). Two parts of that topology have no lane evidence (#654).

- **Holder restart (gap 1).** The behaviour after a holder restart was measured once, in throwaway containers:
  - `docker restart` of the holder gives it a new namespace while the DS stays in the old one;
  - `docker compose … up -d` does nothing;
  - `docker restart dsh-team-documentserver` rejoins the DS.

  `docs/DEPLOY.md:122` and `deploy/README.md:13` state this recovery as fact. The `test:deploy` exposure checks are identity-only: DS `NetworkMode` is `container:<holder.Id>`, and `NET_ADMIN` is set only on the holder (`deployment.docker.test.ts:571-609`). A restarted holder keeps its ID, so the lane cannot tell a healthy deployment from a trapped DS.

- **IPv6 rules (gap 2).** `deploy/document-server-net.sh:28` installs the IPv6 rules only when `/proc/net/if_inet6` exists. No lane reads them back on a real kernel.

## What Changes

- **Holder restart sequence** in `test:deploy`, after the existing initial `firewallReach` (the order is required):
  1. `docker restart dsh-team-documentserver-net`, then wait, with a bound, for it to be healthy again. Assert:
     - the holder ID is unchanged;
     - DS `NetworkMode` is still `container:<same id>`;
     - `firewallReach` returns `inside: [refused, refused]`: the new namespace has no listener, so the Document Server is not in it;
     - from each instance, +4:80 is `refused` and +4:8000 is `timeout`: the new namespace's rules are in place. These outcomes are inferred, not measured.
  2. `[...deployment.compose, 'up', '-d', '--no-build', '--pull', 'never']`. Assert:
     - `Id` and `State.StartedAt` are unchanged for the platform, holder, Document Server and both instances;
     - the reach outcomes are the same as after step 1.
  3. `docker restart dsh-team-documentserver`, then wait, with a bound, for the #648 healthcheck to report healthy. Assert that from each instance `firewallReach` is back to `inside: [answered, answered]`, `outside: [answered, timeout]`.
- **IPv6 readback** in `test:deploy`. Run `ip6tables -S INPUT` in the holder as root and require exactly:

  ```text
  -P INPUT DROP
  -A INPUT -i lo -j ACCEPT
  -A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  -A INPUT -p tcp -m tcp --dport 80 -j ACCEPT
  -A INPUT -p ipv6-icmp -j ACCEPT
  ```

  This was measured on 2026-11-21 on arm64 Docker Desktop with `node:24.13.1-bookworm-slim` plus `iptables` 1.8.9 (nf_tables), the platform image's runtime layer. Task 0.1 re-measured it on giap-vps (amd64) with the same runtime layer: the output is identical. Any missing or extra line fails. A missing `/proc/net/if_inet6` in the holder also fails. If 0.1 shows giap-vps has none, the readback is not implemented and the owner decides. The readback runs again in the new namespace after the holder restart.

- **IPv6 behaviour probe.** Not in this change. Task 0.1 measured that the giap-vps daemon creates IPv6 networks, so the probe is a second change under #654. This PR says `Refs #654`.
- **Docs.**
  - `docs/DEPLOY.md:122` and `deploy/README.md:13` cite the lane, and any wording the lane contradicts is corrected.
  - In `deploy/README.md:13`, "installed and self-checked but not probed" becomes "read back by the deploy lane; behaviour not probed".
  - `deploy/README.md` § Evidence required: Compose deployment (`:39-43`) gains the restart sequence's three expectations and the readback.

## Triage

```text
Issue type: test (+docs)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: deploy lane only (giap-vps); a restart step left half-done could leave a run's own DS trapped until cleanup (own resources only); a wrong reach expectation fails the lane; docs are operator-facing recovery steps
Selected risk packs: Concurrency / shared state / ordering (restart order, health waits); Error handling / rollback / partial outputs (a failed step must leave cleanup intact); Auth / permissions / secrets (security-boundary evidence: firewall rules, NET_ADMIN); Documentation / migration notes (operator recovery)
Evidence floor: red proof that the identity checks alone pass on a trapped DS (step 1 asserts it); exact-head VPS pnpm test:deploy + test:docker with confirmed cleanup; pnpm check
```

## Capabilities

### Modified Capabilities

- `deployment`: the holder's restart behaviour, the operator's recovery command and its IPv6 rules are lane-verified.

## Impact

- `platform/test/document-server-net-fixture.ts` gains the restart sequence and readback helpers. `platform/test/deployment.docker.test.ts` (777 physical lines, close to the 800 effective-line limit) calls them in one or two lines.
- `deliveredHealthcheck` and `healthyWithinStartPeriod` move from `deployment-document-server.docker.test.ts` into `document-server-net-fixture.ts`. They are rewritten Vitest-free and parameterised, never copied, and their caller is updated.
- `docs/DEPLOY.md` and `deploy/README.md`.
- Out of scope: `platform/src/orchestrator/`, `deploy/compose.yml`, `deploy/document-server-net.sh` and the topology itself.
