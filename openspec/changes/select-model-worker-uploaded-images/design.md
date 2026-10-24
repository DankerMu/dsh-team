## Context

Diagnosis evidence: #319 comment `issuecomment-6377817764`, local `.run/issue319/diag-77c5d913/`.

## Decisions

Change surface: restricted worker driver launch (`platform/test/ci-vps-worker.ts` `execute()` driver spawn and its inline driver environment allowlist); `scripts/docker-build-diagnostics.mjs` `lastBuildHeader`; AGENTS.md.

Must preserve:

- Driver environment allowlist semantics: only named fields reach `pnpm test:model`; `DMXAPI_KEY` loading/redaction unchanged.
- Install/build/checkout environments, SSH/systemd arguments and GitHub secrets never carry the selection path.
- Absent selection ⇒ byte-identical native behavior (no `DSH_TEAM_VERIFICATION_IMAGES` in the driver child).
- The adapter (`scripts/verification-image.mjs`) stays the only validator of mapping/layout content; no new parser.
- Phase/execution/final receipt fields, categories and owner parsing unchanged; receipts never contain the path.
- Existing recognized headers keep their projections; `[private-stage 1/1]` and other unknown stage names stay unknown; vertex/step bounds unchanged.

Must add/change:

- Selection source: exactly `join(homedir(), '.config/dsh-team/verification-images', `${approved.sha}.json`)` where `approved.sha` is the already validated 40-hex reviewed SHA. Presence is decided by the worker's existing `exists()` helper (`lstat`; `ENOENT` ⇒ false, other errors throw): absent ⇒ unset; any existing entry (including symlink, wrong mode, directory) ⇒ exported, so the adapter rejects it fail-closed; any other error throws. Ordering is mandatory: `enter('driver')` → `exists()` → driver spawn, so a presence failure is recorded by the existing catch as `{phase:'driver', state:'failed', category:'unknown'}` and never attributed to the settled build phase (`ci-vps-worker.ts` L231-236, L536-541).
- The outer driver spawn keeps using only the fixed `environment` plus named fields (never `process.env`), and the inline allowlist copies names before `process.loadEnvFile`, so an inherited or env-file `DSH_TEAM_VERIFICATION_IMAGES` never reaches `pnpm test:model`.
- The driver inline allowlist adds `DSH_TEAM_VERIFICATION_IMAGES` (undefined values are not passed by Node spawn).
- Header grammar: stage token `build|runtime|stage-0`, one or more spaces before `i/N`; projected `phase` is the literal stage token.

Governing invariant: the restricted model lane uses uploaded images only when the operator staged a mapping named by the exact approved SHA, and that selection reaches only the driver child.

Sibling surfaces: ordinary custody lane (`trusted-docker-run.mjs`) – unchanged, already passes the caller's selection; independent watcher/owner cleanup – derived images keep case labels, so canonical exact-label cleanup is unchanged, and layouts are operator-owned outside the invocation directory; `platform/test/docker-command.ts` – shares `buildFailureDiagnostic`, benefits from the same grammar.

Seams under test: the real worker entry via the `ci-vps-worker` fixture, extended with a staging option (sha mapping / other-SHA / symlink / ENOTDIR / canaries) and a per-call `DSH_TEAM_VERIFICATION_IMAGES` projection in `parseCalls`, so assertions are per recorded call (git, install, build, driver); `createDockerCommands` diagnostic projection in `docker-build-diagnostics.integration.test.ts`.

Required evidence:

- Staged `<sha>.json` ⇒ recorded `pnpm test:model` environment has exactly that path; install/build/git environments and phase/execution/final receipts do not contain it.
- Mapping for another SHA only, or absent directory, with a canary `DSH_TEAM_VERIFICATION_IMAGES` in both the worker's inherited environment and `~/.config/dsh-team/env` ⇒ no variable in the driver `pnpm test:model` environment.
- `~/.config/dsh-team/verification-images` is a regular file (ENOTDIR) ⇒ `phase.json` `{phase:'driver', state:'failed', category:'unknown'}`, `execution.json` `{exitCode:1, phase:'driver', category:'unknown'}`, no `pnpm test:model` call recorded.
- Symlink at `<sha>.json` ⇒ path exported (adapter rejection follows from its O_NOFOLLOW/regular-file/uid/nlink/mode checks in `scripts/verification-image.mjs`; no existing adapter test feeds a symlinked, directory or 0644 mapping, a pre-existing gap reported in PR #328), never resolved by the worker.
- `#15 [stage-0  2/11] RUN …` ⇒ `{phase:'stage-0', step:2, total:11, instruction:'RUN'}`; `#6 [build  2/10] RUN …` ⇒ `{phase:'build', step:2, total:10}`; `[private-stage  1/1]` stays unknown. RED on current main first.

Non-goals: host-local layout transfer automation inside `pnpm ci:model`; proxy build arguments, mirrors, host/daemon/network changes; deadlines; adapter changes; #319 item 4 never-created image ownership proof; the real-model run itself (separately authorized after merge).

Review focus:

1. The selection path is SHA-bound and reaches only the driver child (no leak into install/build/git/SSH/receipts).
2. Absence is exactly native; presence never silently degrades to native.
3. Header grammar widening admits only `stage-0` and padding, not arbitrary stage names.
4. AGENTS.md operator procedure is accurate and does not claim Buildx registry transport proof for uploaded runs.

Accepted residual risk: a missing or misnamed mapping silently selects native builds (unchanged legacy behavior); the operator procedure requires confirming the exact host `<sha>.json` exists before `pnpm ci:model`. The SHA name binds selection, not layout provenance, which remains operator responsibility; `pnpm test:model` needs all three roles (`user`, `platform`, `browser`).
