## 1. Host-local configuration and canonical projection

- [x] 1.1 Add a real-file/owned-process HTTP proxy tracer regression proving restricted host-local precedence over ambient values, observe RED, then extend the existing canonical projection and observe GREEN; preserve the ordinary caller path in the existing proxy integration suite.
- [x] 1.2 Add and exercise bounded same-descriptor privacy/schema/loopback rejection, absent/empty/bypass and atomic replacement cases; verify fixed errors, no unauthorized child/network work and no raw credentials in retained evidence through `pnpm test:integration`.
- [x] 1.3 Document the fixed private source, field/permission contract, absence/invalid behavior and operator-only installation in existing trusted verification guidance; check `pnpm lint:agents` and formatting, without installing or reading real host credentials.

## 2. Restricted worker and downstream custody

- [x] 2.1 Bind independent worker Docker projection to its validated invocation without adding proxy values to driver/general environments, SSH/systemd arguments or authorization payloads; prove the actual worker/driver path with owned external command boundaries and existing one-shot owner tests.
- [x] 2.2 Audit acquisition/rescue carriers, root verifier, actual browser/employee injection boundaries and both standalone dependency closures; run actual entrypoint/manifest-selected archive smokes and canonical proxy/diagnostic/model-entry regressions, retaining explicit limits of substitutes.

- [x] 2.3 Give only the worker's exact-SHA checkout `git` children the validated host-local proxy projection (child environment only), retaining the SHA equality gate and phase evidence. Prove (a) with real git and the fixed remote unchanged, an owned loopback CONNECT recorder receives `CONNECT github.com:443` through a credential-bearing proxy-URL canary, then refuses the tunnel, so checkout fails with closed `{phase:'checkout',state:'failed',category:'nonzero',exitCode}` and the canary is absent from phase/execution/final receipts and worker stderr; (b) with the existing owned executable fixture's recorded environments, git fetch receives exactly the host-local fields while git argv/`.git/config` contain none and pnpm install/build/driver environments contain no proxy field; (c) absence yields git environments without proxy fields (no external network); (d) invalid configuration records no `git fetch` call and phase `{phase:'checkout',state:'failed',category:'unknown'}`. Observe RED on the current checkout first.
- [x] 2.4 Update the trusted verification guidance (AGENTS.md host-local proxy paragraphs) so only the exact-SHA checkout `git` children additionally receive the projection while install/build/driver remain excluded; check `pnpm lint:agents` and formatting.

## 3. Integration and separately authorized acceptance

- [x] 3.1 Run canonical checks, high-risk four-seat review and exact reviewed-head trusted Compose/full Docker with independent resource/host-fence evidence; no changed deadline, discovery, retry or daemon/service policy. Delivered by PR #295: the four-seat round 1 was clean, and exact-head trusted Docker/Compose evidence was recorded on `f17fc305`.
- [x] 3.2 Obtain separate explicit authorization for any host-local config installation and exactly one final-SHA real-model invocation, then prove original model acceptance and complete independent credential/resource cleanup. No simulated substitute or retry. Reworded by user decision (2026-10-24): the accepted route uses operator-uploaded SHA-bound images (#328), so actual Buildx/registry token transport through the loopback proxy is **not** proven. It is recorded as an accepted residual risk. Evidence:
  - The host config was installed under authorization (`docker-proxy.json`, uid1000/0600).
  - Earlier separately authorized runs on the PR #295 branch (`cce7783b`, `5314a327`) failed before acceptance; their causes remain UNKNOWN, and neither was retried.
  - The authorized run on `9a6a5ef` (`377e875f`) failed in the probe-2 oracle (#332), and that authorization was not retried.
  - The separately authorized run on `39f5af4` (`783d7e36`, Actions 40156135665) passed 2/2, with cleanup confirmed and host fences unchanged.
- [x] 3.3 After every acceptance gate is satisfied, complete protected CI/full check-rollup review, merge, main CI and managed spec synchronization/archive; human acceptance remains deferred and UNPASSED. Merged via PR #295. This archive completes the spec synchronization. Human acceptance remains deferred and UNPASSED.

## Risk mapping

- Selected: public script entry/config/schema →1.1–1.3,2.1; one fixed source, closed fields, non-CI compatibility.
- Selected: file IO/path safety/resource bounds →1.2; one no-follow/nonblocking descriptor, regular same-UID0600 metadata,16384-byte read cap, close on every path.
- Selected: auth/permissions/secrets →1.1–2.3,3.2; hostile ambient values, private-file and output canaries, exact process/transport boundaries and one-shot custody.
- Selected: concurrency/ordering →1.2,2.1; metadata/content bind to opened identity, atomic replacement between calls, no shared mutable cache or remote selected source.
- Selected: error handling/partial cleanup →1.2,2.1; invalid config fails closed, original model/cleanup outcomes remain separate, no ambient fallback or broader retirement authority.
- Selected: compatibility/release/packaging →1.1,2.2,3.1; existing helpers/callers, browser image and separately packaged trusted worker remain runnable.
- Selected: documentation/migration →1.3,2.4,3.2; existing guidance only, configuration and provider authorization separate from code delivery.
- Not selected: platform HTTP/schema/database, production image changes, proxy/service provisioning or global daemon policy; explicit non-goals. No dependency addition.
