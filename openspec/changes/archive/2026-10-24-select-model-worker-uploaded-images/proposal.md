## Why

Issue #319 records the second authorized one-shot real-model run (invocation `5314a327…`) failing in its driver because the browser verification image build hit the 600s deadline. The bounded operator diagnosis on 2026-10-23 (main `1ea697b`, owned tags `dsh-team-diag-*-77c5d913`, the restricted worker's own client environment) established:

- the client-side host-local proxy covers metadata/token resolution (5.4s) and the pinned base was cached;
- BuildKit `RUN apt-get` containers bypass that proxy and egress through the host's own policy routing, which is intermittent on giap-vps: the browser build passed once (82.6s, Packages at 254 kB/s), while the user and platform builds failed with `connection timed out` minutes later;
- the retained `lastObservedBuildHeader` cannot name such a stall, because single-stage builds emit `[stage-0  i/N]` and BuildKit pads `i/N` with spaces when N ≥ 10 (`[build  2/10]`), neither of which the recognizer accepts.

Proxy build arguments, mirror rewrites, host or daemon network changes are prohibited (AGENTS.md, #313). The reviewed `DSH_TEAM_VERIFICATION_IMAGES` adapter already lets ordinary trusted verification consume operator-built OCI layouts without VPS dependency builds, but the restricted model worker cannot select it.

## What Changes

- The restricted worker selects an operator-staged, SHA-named host-local image mapping `~/.config/dsh-team/verification-images/<approved-sha>.json` and exports its path as `DSH_TEAM_VERIFICATION_IMAGES` to the `pnpm test:model` driver only. Absence preserves native builds; any other present entry is passed to the existing adapter, which fails closed without native fallback.
- The build-failure header recognizer accepts the fixed `stage-0` stage name and space-padded `i/N` steps; unknown stage names stay unrecognized.
- AGENTS.md documents the operator procedure (build final reviewed-SHA layouts locally, transfer, private permissions, keep frozen until the run settles, remove afterwards).

## Impact

- Code: `platform/test/ci-vps-worker.ts`, `scripts/docker-build-diagnostics.mjs`; regressions in `platform/test/ci-vps-worker.integration.test.ts` and `platform/test/docker-build-diagnostics.integration.test.ts`.
- Docs: `AGENTS.md` trusted upload and restricted model paragraphs.
- No change to authorization, admission, deadlines, phase/final receipts, cleanup, owner parsing, adapter validation, provider calls or GitHub channel. Item 4 of #319 (never-created image ownership proof) is a separate design question, not part of this change.

## Triage

```text
Issue type: bugfix (restricted acceptance transport)
Fixture level: expanded
Upstream suggested level: absent (override: secrets-adjacent host-local input selection inside the one-shot model custody lifecycle)
Blast radius: a wrong selection could run the authorized model acceptance against images of another revision, leak a private path/selection into install/build/SSH surfaces, or silently fall back to native builds and consume the one-shot authorization on a known-unreliable path.
Selected risk packs: Config / project setup; File IO / path safety; Auth / permissions / secrets; Error handling / partial outputs; Legacy compatibility; Documentation
Evidence floor: pnpm check:fast; pnpm test:integration platform/test/ci-vps-worker.integration.test.ts platform/test/docker-build-diagnostics.integration.test.ts platform/test/ci-vps-owner.integration.test.ts; RED-before/GREEN-after for selection export and padded/stage-0 header recognition
```
