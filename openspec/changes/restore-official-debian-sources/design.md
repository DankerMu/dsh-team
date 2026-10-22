# Design

## Context

See proposal.md and issue #313. One eight-line helper currently rewrites ordinary Debian sources; both Dockerfiles and five build/provisioning callers depend on its named context. The user now explicitly chooses the official source policy.

## Goals / Non-Goals

**Goals:** preserve the pinned bases' original ordinary/security source files and trust configuration across every build entrypoint; delete the obsolete mechanism rather than introduce a second selector.

**Non-goals:** source-policy fallback/configuration, proxy/service changes, TLS bootstrapping, dependency/base updates, provider execution, and local artifact acquisition/custody redesign. The latter remains a separate part of the approved local-build route and cannot be claimed by this source-policy change.

## Decisions

- Remove the helper invocation and mount from each existing apt RUN; retain apt update/install/cleanup, package ordering and all subsequent image instructions.
- Delete the helper and its helper-only tests because the authorized behavior is removed. Do not replace them with a no-op helper, compatibility alias, Dockerfile-text test or test that only pins implementation wording.
- Remove the obsolete named context from these five executable callers: `platform/test/user-image-fixture.ts`, `scripts/verify-browser-runtime.mjs`, `scripts/probe-dsh-api.sh`, `scripts/probe-first-run.sh` and `scripts/probe-sandbox.sh`.
- Reconcile these six live documentation consumers, including context-count prose: `AGENTS.md`, `docs/DEPLOY.md`, `images/seccomp/README.md`, `plugins/office-agents/README.md`, `plugins/permission-tiers/README.md` and `plugins/zh-locale/README.md`.
- Preserve all three plugin named contexts (`zh-locale`, `permission-tiers`, `office-agents`), both narrow primary image directories and the browser's `browser-runtime` context. The no-live-consumer check covers the full inventory above; historical archives remain excluded.
- Modify the two existing source-policy requirements, replacing helper-specific scenarios rather than keeping contradictory requirements. Historical archives describe past decisions and remain unchanged.
- Reuse the original runtime oracles and failure diagnostics. Source selection has no new runtime API or configuration field.

## Risks / Trade-offs

- Official repository reachability remains external → fail visibly under original deadlines; no retry/fallback or relaxed trust.
- Local apt comparison is narrower than a full image → require both complete amd64 image builds and effective source/trust observations before claiming acquisition success.
- Images can compile but fail on Linux → retain existing user version/DOCX/profile and browser confinement/Chinese rendering oracles, plus the exact-head full Docker gate.
- Deleting one context can leave callers/docs stale → enumerate all live consumers and run scoped static checks and build-diagnostic regressions; allow historical archived references only.
- Base/source policy is not whole-image reproducibility → preserve source/image/archive identities without claiming dynamic apt/npm resolution is frozen.

## Migration Plan

Atomic caller/recipe/documentation cutover on a main-based branch, independent of unmerged #274/#303 work. Preserve original RED receipts and the official-source comparator; run focused checks, review the frozen candidate, build both images locally and retain actual VPS runtime evidence. Rollback is a reviewed git revert, never an automatic mirror fallback. Critical-path and rule-file human review remains deferred/unpassed.
