## Risk packs

- **Config / project setup — selected.** New `documentserver.healthcheck` in the delivered compose; the probe must run in both images and cannot self-match. Tasks 1.1, 1.2; evidence 2.2, 2.3.
- **Legacy compatibility — selected.** F40 and no-Session hints byte-identical; `depends_on`/mounts/env and platform instance start unchanged; existing stack waits and PR #623 assertions kept. Tasks 1.3, 1.4; evidence 2.1, 2.3.
- **Error handling — selected.** Healthy never before the final step (no false readiness); stand-in reaches healthy through the same definition (no bypass, no permanent unhealthy). Tasks 1.1, 1.2, 1.4.
- **Documentation — selected.** `docs/DEPLOY.md` window, triggers and wait procedure; `plugins/office-hints/README.md` third hint; required sibling updates `deploy/README.md:23` and `:43`, `platform/test/README.md:92`, `docs/LOCAL_STACK.md:144`. Task 1.5.
- **Release / packaging — selected.** `plugins/office-hints` ships in the user image; the unchanged manifest/engines and the Docker image tests (`pnpm test:docker`) cover delivery. Evidence 2.3.
- **Concurrency / shared state / ordering — selected.** The invariant is an ordering claim (healthy vs final step vs spawns), and the Docker probe and the stack oracle run concurrently in the same container: probe/oracle mutual non-match, sampler from `compose up`, health read before pgrep. Tasks 1.1, 1.4; evidence 2.2.
- **Public API / CLI / script entry — not selected.** The only entry point touched is the test-only stand-in entrypoint (task 1.2); no product CLI, route or script changes.
- **Not selected:** schema/HTTP (no route change), auth/secrets (JWT env untouched), file IO/path safety, resource limits (the sampler is bounded by the existing stack wait; Docker's probe runs every `interval`).

## Acceptance-criteria mapping

- AC1 (direction in PR description) → task 1.6.
- AC2 (stack: healthy not before final step; spawns stable; deploy stand-in neither failing nor bypassed) → tasks 1.1, 1.2, 1.4; evidence 2.2, 2.3.
- AC3 (platform consults readiness) → not applicable: owner rejected blocking at start.
- AC4 (hint appear/disappear) → reinterpreted per the owner's static-note decision: the note appears with the Office wrapper in a Session and is absent in the no-Session and unloaded views; it is never time-driven, so 'disappears after the window' does not apply. Unit tests 1.3; stack screenshot 2.2.
- AC5 (DEPLOY.md) → task 1.5.
- AC6 (no lengthened deadlines, no skipped cases, PR #623 assertions kept) → tasks 1.4 and design must-preserve.

## Must preserve

See `design.md`.

## 1. Implementation

- [x] 1.1 `deploy/compose.yml` `documentserver.healthcheck` per the design contract (no self-match; works in both images; `start_period` ≥ 300 s, short `start_interval`). Record the probe choice and timing rationale in a comment.
- [x] 1.2 `platform/test/deployment-compose-fixture.ts` stand-in entrypoint ends in a long-lived `xargs tail -F` process after starting the two responders; no `healthcheck` key; update `deployment-compose-fixture.integration.test.ts` expectations; `deployment-document-server.docker.test.ts` asserts `healthy` within the start period, `Config.Healthcheck.Test` equal to the delivered compose's `documentserver.healthcheck.test`, and that command via `docker exec dsh-team-documentserver-net` exits nonzero.
- [x] 1.3 `plugins/office-hints/client.js` adds the `restart` note (exact text from proposal.md, `data-dsh-team-office-hint="restart"`) beside the collaboration hint only; `client.test.js` covers presence with each Office ext in a Session and absence in the no-Session and unloaded views (red first; `:307,308,367` grow, `:293` unchanged); `README.md` hint table gains the row. Stack consumers: `openHinted`'s exact assertion becomes `[collab, restart]` for all four lanes (editor, rewrite, forgotten ×2, hints) and the integration `mounted` mock is updated.
- [x] 1.4 Stack lane health timeline per design.md: concurrent sampler from `compose up`, health read before pgrep, ≥1 `starting` sample with pgrep missing plus a nonzero-ExitCode `Health.Log` entry, healthy ⇒ pgrep, spawns at first healthy = final count; counts in the evidence line; the office-hints lane asserts the `restart` note is visible. No deadline lengthened, no PR #623 assertion removed.
- [x] 1.5 `docs/DEPLOY.md` §「自带 Document Server（Office）」: cause, triggering operations, `docker inspect --format '{{.State.Health.Status}}' dsh-team-documentserver` until `healthy` before announcing Office. Also required: `deploy/README.md:23` and `:43`, `platform/test/README.md:92`, `docs/LOCAL_STACK.md:144` (see design.md sibling surfaces).
- [ ] 1.6 PR description states the chosen direction and why blocking-at-start and docs-only were rejected (issue AC1), plus the static-note reinterpretation of AC4 below.

## 2. Verification

- [x] 2.1 `pnpm check` (unit + integration incl. office-hints and compose fixture tests).
- [ ] 2.2 Local exact-head `pnpm test:stack`: health timeline, restart-note screenshot, zero new console errors, inventory/volume fence.
- [ ] 2.3 Exact-head VPS `pnpm test:docker` + `pnpm test:deploy` (stand-in healthy) with confirmed cleanup; CI green.

## Non-goals

See `design.md`.
