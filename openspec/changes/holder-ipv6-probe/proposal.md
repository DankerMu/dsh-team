# IPv6 behaviour probe of the Document Server firewall

## Why

This change is the second change under #654, for AC4. The first change (#683, `holder-restart-lane`) covered AC1–AC3 and AC5. Line numbers refer to main at the change's base.

- **The holder's IPv6 rules are read back, but nothing sends IPv6 traffic through them.**
  - `deploy/document-server-net.sh:28` installs the IPv6 rules when `/proc/net/if_inet6` exists.
  - The deploy lane reads `ip6tables -S INPUT` back exactly (`holderIpv6Rules`, `platform/test/document-server-net-fixture.ts:183-192`).
  - Every reach probe goes over the instances' IPv4 bridges (`firewallReach`, `:56-80`). `docs/DEPLOY.md:283` says so: 「实例网络只有 IPv4……IPv6 规则会安装并逐条自检，但没有探测」.
  - So a rule list that reads back correctly but does not filter, for example on a kernel where the `ip6tables` front end does not reach the packet path, still passes.
- **The VPS supports IPv6 networks.** `holder-restart-lane` task 0.1 measured `docker network create --ipv6` succeeding on giap-vps with an automatic ULA `/64`. So AC4 takes its first option, a behaviour probe over a temporary IPv6 network, not the review-only fallback.
- **Listeners are dual-stack.** On the deploy lane, the Document Server stand-in's two responders are node `listen(port)` with no host (`platform/test/deployment-compose-fixture.ts:82-85`), which binds `::`. The real image's nginx listens on `[::]:80` (`/etc/onlyoffice/documentserver/nginx/ds.conf:4` in `onlyoffice/documentserver:9.4.0`).

## What Changes

- **New step in `test:deploy`'s exposure case.** It runs after the holder restart sequence, once the Document Server has rejoined the holder (the `joined` topology). The function is `holderIpv6Reach`, in `document-server-net-fixture.ts`. In order:
  1. Register, then create, an owned internal IPv6 network `dsh-team-v6-net`: `--ipv6 --internal`, labelled with the run's ownership.
  2. Connect the holder `dsh-team-documentserver-net` to it. Read the holder's `GlobalIPv6Address` on it, which must be a non-empty IPv6 literal.
  3. **Inside control.** From the holder's own namespace, as root, reach that address on 80 and 8000. Both must answer: the stand-in listens on IPv6 on both ports, and the traffic arrives on `lo`.
  4. **Outside probe.** Read the holder's IPv6 `INPUT` DROP-policy packet counter before and after. From an owned probe container `dsh-team-v6-probe` on that network (the deployment's platform image, uid 1001), reach the same address on 80 and 8000: 80 must answer, 8000 must time out.
     - **Why the timeout is the holder's IPv6 `DROP`:**
       - it is a timeout, not refused: a port without a listener would answer with a reset;
       - 80 answers in the same probe, so the path itself is up;
       - the holder's DROP counter rises.
  5. Then, in `finally` on every path: remove the probe container if it is present, disconnect the holder, and remove the network.
  6. After cleanup, the holder's network names equal those before step 2.
- The **outcomes** go into the step's thrown message on mismatch: the observed reach, the address family and the network's IPv6 subnet. The IPv6 address itself is not secret.
- **Budget.** The case's literal timeout grows by this step's bounds, with its comment.
- **Docs.**
  - `docs/DEPLOY.md:283`: replace 「IPv6 规则会安装并逐条自检，但没有探测」 with the probe.
  - `deploy/README.md:13` and `:43`: the IPv6 behaviour probe in the evidence list.

## Triage

```text
Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: test:deploy exposure case on giap-vps; the step attaches a network to the delivered holder, so a leaked network, a leaked probe container or a lasting topology change would affect the rest of the lane and the host fence
Selected risk packs: Error handling / rollback / partial outputs (cleanup in finally on every path, registration before creation); Security boundary evidence (the probe must distinguish DROP from a missing listener and from IPv4)
Evidence floor: integration cases with a stand-in command red under mutants per design § Required evidence, green after; pnpm check; exact-head trusted VPS test:docker + test:deploy with the new step and the host fence
```

## Capabilities

### Modified Capabilities

- `deployment`: the Document Server holder's IPv6 firewall is proven by behaviour, not only by its rule list.

## Impact

- `platform/test/document-server-net-fixture.ts` and its integration test.
- `platform/test/deployment.docker.test.ts`: the exposure case calls the step, and its timeout literal and comment change.
- `docs/DEPLOY.md:283`, `deploy/README.md:13` and `:43`.

Unchanged:

- `deploy/compose.yml` and `deploy/document-server-net.sh`;
- `platform/src/orchestrator/` and product code;
- the holder restart sequence and the IPv4 reach assertions;
- the local stack lane.

## Risk packs

- **Error handling / rollback / partial outputs — selected.** Every resource is registered before it is created, and is removed in `finally`. Tasks 1.1, 1.2.
- **Security boundary evidence — selected.** Several things together tell IPv6 `DROP` apart from a missing listener and from an IPv4 fallback: the inside control, timeout versus refused, and an asserted IPv6 literal as the target. Tasks 1.1, 1.2.
- **Not selected:** secrets (no JWT or key involved; the probe prints outcomes only), product code, concurrency (the deploy lane holds the host-wide deployment lock).

## Acceptance-criteria mapping (#654)

- **AC4** (the IPv6 behaviour probe: on the VPS, over a temporary IPv6 network, 80 answers and 8000 times out) → 1.1–1.3, 2.2.
- **AC5** (the orchestrator unchanged, no existing deadline raised, no assertion weakened, every new wait bounded) → 1.1, 1.3.
- AC1–AC3 were met by #683. #654 closes when this change merges.
