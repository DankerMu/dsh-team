# Design

## Change surface

- **`platform/test/document-server-net-fixture.ts`:** a new exported `holderIpv6Reach`, which reuses the file's `reach` and `REACH`. There is no second reach script.
- **Its integration test:** the new cases, driven by a stand-in command, as the existing `holderRestartSequence` and `firewallReach` cases are.
- **`platform/test/deployment.docker.test.ts`:**
  - the exposure case (`:555-661`) calls the step after `holderRestartSequence`;
  - the case's timeout literal and its budget comment (`:549-554`) change.
- **Docs:** `docs/DEPLOY.md:283`, `deploy/README.md:13` and `:43`.

## Must preserve

- `holderRestartSequence`, `holderIpv6Rules`, `firewallReach` and every existing IPv4 reach assertion, unchanged.
- **Delivered files untouched:** `deploy/compose.yml`, `deploy/document-server-net.sh` and `platform/src/` are unchanged.
- **No existing wait is lengthened.** The case's timeout grows only by the new step's own bounds, itemised in its comment.
- **Topology restored.** After the step, the holder is on exactly the networks it was on before, and the Document Server still joins it. The rest of the case and later cases see the same topology as today.
- **Cleanup authority.** Exact names only, registered with `lifecycle.registerResourceAsync` before creation (`deployment-fixture.ts:82-91` is the pattern). Never prefix-wide deletion. The host fence (registered targets absent, no owned resources) must still pass.
- **Limits:** 800 lines per file (as `max-lines` counts them), complexity 15, 200 lines per function.

## Must add/change

- **`holderIpv6Reach(lifecycle, image, ownership)`.**
  - `lifecycle` is `Pick<UserImageLifecycle, 'commandAsync' | 'registerResourceAsync' | 'removeNetwork'>`. `removeNetwork(name, id)` (`user-image-fixture.ts:126`, `:661-666`) is the existing owned-network removal: synchronous, by exact ID, through `removeOwnedNetwork` (`docker-cleanup.ts:56-101`), which needs the network to have no containers. No new removal path is added.
  - `image` is the holder's own image: the case passes `String(holder.Image)` from its existing `holder` inspect and checks it matches `^sha256:[a-f0-9]{64}$`. That image (the platform image) has `node` and `sleep`, and runs a numeric `--user 1001`.
  - `ownership` is `{ [OWNER_LABEL]: lifecycle.runId }`, as `deployment.docker.test.ts:45` writes it.
  - **Steps, each docker call bounded at 30 s:**
    1. **Register** `network dsh-team-v6-net` and `container dsh-team-v6-probe` (one `inspect` each inside `registerResourceAsync`, `user-image-fixture.ts:347`). Then record the holder's network names (`container inspect`).
    2. **Network.** `docker network create --ipv6 --internal` with the ownership labels, named `dsh-team-v6-net`, its IPv6 subnet left to Docker's automatic ULA. Its ID is create's trimmed stdout, which must match `^[a-f0-9]{64}$`. `--internal` gives the network no gateway, so connecting it changes no default route in the holder's namespace.
    3. **Connect.** `docker network connect dsh-team-v6-net dsh-team-documentserver-net`.
    4. **Address.** `container inspect` of the holder: `NetworkSettings.Networks['dsh-team-v6-net'].GlobalIPv6Address` must satisfy `net.isIP(address) === 6`. Otherwise throw before any probe, naming the network's IPv6 subnet (`network inspect`) as context.
    5. **Probe container.** `docker run -d` with the ownership labels: name `dsh-team-v6-probe`, `--network dsh-team-v6-net`, `--user 1001`, `--entrypoint sleep`, the image, `infinity`. Its ID is run's trimmed stdout.
    6. **Drop counter before.** As root in the holder, `ip6tables -L INPUT -v -x -n`. Take the packet count from its first line, `Chain INPUT (policy DROP <n> packets, <m> bytes)`. A line of any other shape throws.
    7. **Inside control.** `reach(run, DOCUMENT_SERVER_NET, 'root', targets(address))`.
    8. **Outside probe.** `reach(run, 'dsh-team-v6-probe', '1001', targets(address))`.
       - Here `targets(address)` is `[80, 8000]` with `host: address` and `path: '/'`, as `INSIDE`/`OUTSIDE` use.
    9. **Drop counter after.** The same read as step 6.
    10. **Assert.**
        - Expected: `{ inside: [OK, OK], outside: [OK, TIMEOUT], dropped: true }`, where `OK` is `answered 200` (as the stand-in answers), and `dropped` is the after count greater than the before count.
        - Outside 80 answering in the same exec is what pins the 8000 timeout to the port. A path that is down for both ports (NDP, a missing probe address, Docker's isolation rules) fails on 80.
        - The DROP counter rising pins the timeout to the holder's own policy, not to a filter outside it.
        - On a mismatch, throw with the observed values and the expected ones.
  - **Cleanup in `finally`, on every path, for every step that was attempted** (an attempted step may have taken effect even if its call failed or timed out), in reverse order:
    - `docker rm -f <id>` when run returned an ID. Without an ID, the registered container is left to `finish()`, whose `removeOwned` checks the ownership label before removing (`docker-cleanup.ts:115-130`); never `rm -f` by name.
    - `docker network disconnect --force dsh-team-v6-net dsh-team-documentserver-net`. If it fails, inspect the holder once: if its `Networks` no longer holds `dsh-team-v6-net`, the disconnect counts as done. This extra inspect happens only on a failure path where later steps did not run, so the worst case stays within the budget;
    - `lifecycle.removeNetwork('dsh-team-v6-net', id)` when create returned an ID. Without an ID, the registered network is left to the lifecycle's `finish()`, which retires registered targets.
    - A resource that is already absent counts as removed. Each cleanup call runs even when an earlier one failed.
    - A cleanup failure never masks the step's own failure. If both fail, throw an `AggregateError` holding both, as `holder-restart-lane` and the editor fixture do.
  - **After cleanup**, on the success path: inspect the holder again; its network names must equal those recorded in step 1.
  - **Returns** `{ address, inside, outside, dropped: { before, after } }`, for the case's evidence. The IPv6 ULA address is not secret.
- **The exposure case** calls `await holderIpv6Reach(lifecycle, String(holder.Image), { [OWNER_LABEL]: lifecycle.runId })` after `holderRestartSequence`. Every value is checked by the step; the case records what it returns.
- **Budget.** The timeout literal becomes `900_000 + 1_380_000 + 600_000` (= `2_880_000`), so the two existing parts stay visible and unchanged. The comment itemises twenty docker calls at 30 s:
  - two registration inspects;
  - the before-inspect, create, connect, address inspect, and the network inspect for context (failure path only, counted anyway);
  - run, the two counter reads and the two reach execs;
  - `rm -f` and disconnect (or the disconnect's fallback inspect);
  - `removeNetwork`'s five calls;
  - the after-inspect.
- **Runner fit.** As #683 0.2 did, the PR states that `2_880_000` fits every runner that runs the case.

## Governing invariant

From outside the holder, over IPv6, port 80 answers and port 8000 is silently dropped, while both listen. The probe leaves no network, container or topology change behind.

## Sibling surfaces

- **`STAND_IN_REACH`** and the IPv4 `firewallReach` stay as they are.
- **The local stack lane** runs the real Document Server image, whose nginx also listens on `[::]:80`. It is not changed: AC4 asks for the VPS, and the stack lane's instance networks stay IPv4.
- **`docs/DEPLOY.md:283`** is the only operator-facing sentence that says IPv6 is not probed. Update it, and leave the rest of §283 as it is.

## Unmeasured assumptions

The following are not measured before implementation:

- `--internal --ipv6` together;
- a network connected to a running holder;
- `GlobalIPv6Address` present in the inspect right after the connect.

`holder-restart-lane` 0.1(c) measured only `network create --ipv6` without `--internal`. Each of these assumptions can only fail red, never pass falsely, because the outside 80 and the inside control must both answer. The exact-head VPS run (2.2) measures them. If one fails, report the observed output and the fix before changing the step.

## Seams under test

- **`holderIpv6Reach` with a stand-in `commandAsync` and `removeNetwork`, sharing one call log**, so that the cleanup order can be asserted.
  - The stand-in records each argv. It answers `container inspect`, `network inspect`, the two reach execs and `run -d` from a script, and `registerResourceAsync` records its calls.
  - The pattern is the existing `holderRestartSequence` integration case.
- **The exposure case** is VPS-only (`*.docker.test.ts`). Its wiring of image and ownership is covered by `test:deploy`.

## Required evidence

Each mutant keeps the field and weakens only the mechanism. Record it red with its case, then green.

- **Positive.**
  - Every resource is registered before its creation, and the network's ID from create reaches `removeNetwork`.
  - The create argv holds `--ipv6`, `--internal` and the ownership labels.
  - The probe runs as uid 1001 on the network.
  - Both reach calls target the inspected IPv6 address.
  - Cleanup runs in reverse order.
  - The holder's networks after equal those before.
  - It returns the reach.
- **Outside 8000 `refused`** must throw. Mutant (a): accept `refused` as well as `timeout`.
- **Outside 8000 `answered`** must throw, and cleanup still runs. Mutant (b): put cleanup after the assertion instead of in `finally`.
- **Inside 8000 `timeout`** (the stand-in not listening on IPv6) must throw. Mutant (c): drop the inside control.
- **Address checks.** An inspected address that is empty, or an IPv4 literal, must throw before any reach exec, and cleanup still runs. The stand-in's empty-address case also gives a non-empty IPv4 `IPAddress`.
  - Mutant (d): fall back to `IPAddress` when `GlobalIPv6Address` is empty.
  - Mutant (d2): weaken `net.isIP(address) === 6` to non-empty. The IPv4-literal case goes red.
- **Create argv without `--internal`** must fail the positive case's argv check. Mutant (e): drop `--internal`.
- **Registration order.** Registration must come before creation. Mutant (f): register after `network create`; the positive case's order check goes red.
- **Holder networks after cleanup differ from before** (the stand-in keeps the network attached) must throw. Mutant (g): skip the after-inspect.
- **A cleanup failure together with a step failure** must throw an `AggregateError` holding both.
- **Outside `[TIMEOUT, TIMEOUT]` or `[failed, TIMEOUT]`** (the path down for both ports) must throw. Mutant (h): assert only `outside[1]`.
- **The positive case's call log names the reach containers:** the holder for the inside control, `dsh-team-v6-probe` for the outside probe. Mutant (i): run the outside probe in the holder.
- **The DROP counter not rising** (the same count before and after) must throw. Mutant (j): drop the counter comparison.
- **`rm -f` failing** must still run the disconnect and `removeNetwork`, and the failure is reported. Mutant (k): stop cleanup at the first failure.
- **Exact-head VPS `test:deploy`:** green with the step, and the host fence unchanged (registered targets absent, foreign containers unchanged).
