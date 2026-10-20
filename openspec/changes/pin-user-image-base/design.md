# Design

## Context

The existing FROM is node:24-bookworm-slim. The issue permits choosing a compatible immutable base, not changing Node major, Debian suite, other images or production functions. Historical passing-run cache identity is not retained; no BuildKit/history inspection is permitted.

## Goals / Non-Goals

Governing invariant: the user-image build selects a reviewed immutable Node24/Bookworm-slim base supporting the existing Linux amd64 target; changing an upstream mutable tag cannot silently select another base.

Must preserve: every remaining Dockerfile instruction, DSH0.2.0-rc.2/pnpm10.34.6 pins, apt/mirror/signature policy, uid1001, profile/seed/workspace/plugin delivery, sandbox/network behavior and all existing acceptance gates.

Non-goals: full image bit reproducibility, apt snapshots/npm transitive pinning, new architecture qualification, host/daemon/proxy changes, model calls, base changes in platform/browser/phase0 images, or historical-cause attribution.

## Decisions

1. Select node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5. Fresh official Docker Hub metadata shows the exact patch tag and current major tag resolve to this index. Official registry response bytes hash to the index, Linux amd64 manifest ec857ea6bb60cb3d0fa4d97495590c5fe7d51be8572c307b55957eeb06569cf7, and config a797d6440ed0b09e51fb884f30e47ec14cbf58482c5e19db681a0cb8df45b089; config records Node24.22.0/linux/amd64. Search-cache digests were not used.
2. Keep the multi-architecture index rather than substituting an amd64-only child; only the existing Linux amd64 deployment is runtime-qualified. Do not copy the browser's older24.13.1 base merely because it is already pinned.
3. Use a disposable configuration-contract check to demonstrate the old reference lacks immutable identity and the new one matches the independently verified release. No permanent source-text test. Existing actual image/consumer tests remain authoritative for behavior.
4. A disposable owned scenario uses the canonical user-image build/cleanup helper and a non-networked default-user container to read actual Node version, Debian os-release and DSH version. Original full Docker and standalone Compose then qualify compatibility on the frozen reviewed head; no narrower probe substitutes for full discovery.
5. Updates require an explicit reviewed PR, fresh registry tag/index/platform/config verification, actual runtime observation and original full trusted acceptance. Digest movement is never silently accepted. Rollback is a reviewed prior reference; no daemon or employee data migration.

## Risks / Trade-offs

[Old cached base is unknown] → claim fresh compatibility only, not historical byte equivalence or root cause.
[Base pin is mistaken for complete reproducibility] → document apt/npm resolution remains dynamic.
[Multiarch index contains untested architectures] → qualify only existing Linux amd64; no new support claim.
[Critical image change] → four-seat independent code/contract review plus deferred human white-box review of every changed line.
