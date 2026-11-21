# Design: bundled Document Server readiness

Change surface:

- `deploy/compose.yml`: `documentserver.healthcheck`.
- `platform/test/deployment-compose-fixture.ts` `documentServerOverride` (the stand-in entrypoint) and its integration test's `toEqual` (`deployment-compose-fixture.integration.test.ts:100-165`).
- `platform/test/deployment-document-server.docker.test.ts`: stand-in health assertion.
- `platform/test/office-hints-stack-fixture.ts` and `platform/test/platform-stack.stack.test.ts` (~:520-570): health timeline.
- `plugins/office-hints/client.js`, `client.test.js`, `README.md`: static note.
- `platform/test/office-hints-stack-fixture.ts`: the note is visible.
- `docs/DEPLOY.md` §「自带 Document Server（Office）」 (~:99-125).

Healthcheck contract:

- Healthy iff a process whose command line starts with the startup script's final step `xargs tail -F` exists in the container.
- Probe and oracle never match each other. The stack oracle `documentServerStarted` (`office-hints-stack-fixture.ts:214`, `pgrep -f 'xargs tail -F'`) runs concurrently with Docker's probe in the same container, so: (a) the healthcheck argv MUST NOT contain the literal text `xargs tail -F` (else the oracle sees the probe's own shell as the final step); (b) the probe MUST anchor on the process's argv[0] being `xargs` followed by `tail -F` (so the oracle's own `pgrep -f xargs tail -F` process cannot make the container healthy). The oracle may additionally be anchored to `^xargs tail -F` as a strengthening, never removed. The probe MUST NOT match itself either. Plain `pgrep -f 'xargs tail -F'` (exec or shell form) violates (a) and (b) and is not allowed; acceptable forms satisfy both, e.g. an argv[0]-anchored pattern such as `^xargs[ ]tail -F` evaluated against each `/proc/<pid>/cmdline`.
- The probe MUST run in both the real `onlyoffice/documentserver:9.4.0` image and the deploy stand-in (the platform image, `node:24.13.1-bookworm-slim`). Verify whether `pgrep` (procps) exists in each. If it is absent from either, use a probe built only from tools present in both, for example a `/proc/*/cmdline` scan with POSIX sh, `tr` and `grep`.
- Timing: `start_period` ≥ 300 s (measured window up to ~135 s, plus first-start allfonts on slow hosts), a short `start_interval` (e.g. 5 s) so healthy is reported promptly, and modest `interval`/`retries`. Record the chosen values and why.

Stand-in:

- `documentServerOverride` keeps the plain responders on 80 and 8000.
- It ends by running a long-lived process whose command line starts with `xargs tail -F`, for example `sh -c '<responders> & exec … xargs tail -F <file>'` or an equivalent. The process must stay alive for the container's lifetime.
- No `healthcheck` key in the override (the delivered definition is inherited) and no `disable`.
- `deployment-document-server.docker.test.ts` asserts the stand-in reaches `State.Health.Status === 'healthy'` within the start period.

Static note:

- Rendered by the wrapper viewer exactly where the collaboration hint is rendered (a docx/xlsx/pptx opened in a Session), as a separate element with `data-dsh-team-office-hint="restart"` and the exact text in proposal.md.
- Not rendered in the no-Session view or the 「Office 编辑器未加载」 fallback.
- The F40 element and text are byte-identical.

Must preserve:

- F40 text and `data-dsh-team-office-hint="collab"`, and the no-Session hint text and marker (office-editing spec :61-78): the text bytes and markers stay identical, while exact hint-array assertions grow to include the note. Concretely: `openHinted`'s exact `toEqual([hint])` (`office-hints-stack-fixture.ts:175`, shared by `office-editor-stack-fixture.ts:331`, `office-rewrite-stack-fixture.ts:305`, `office-forgotten-stack-fixture.ts:344,453`) becomes exactly `[collab, restart]` and is not loosened to `some`; `client.test.js:307,308,367` grow; `:293` (no-Session) stays; the `mounted` mock in `office-hints-stack-fixture.integration.test.ts:65-73` is updated.
- Wrapper registration and priority rules, and the "no hooks" constraint (README).
- `documentserver`'s `depends_on`, `network_mode`, JWT environment and mounts.
- The platform's instance start and overlay behavior; no file under `platform/src/` changes.
- The existing stack waits and assertions: `documentServerStarted` up to 300 s and `docserviceSpawns` equality. Do not lengthen any deadline or drop any PR #623 assertion.
- `deployment-document-server.docker.test.ts`'s existing Running, environment, mount and port checks.

Governing invariant: `dsh-team-documentserver` reports `healthy` only after its startup script's final step is running, so no docservice restart from that startup follows a `healthy` report. The same definition holds for the real image and the stand-in.

Sibling surfaces:

- `documentServerStarted`/`docserviceSpawns` in `office-hints-stack-fixture.ts`. These stay as the test's independent oracle; the product signal is the compose healthcheck, and the duplication is deliberate: the test verifies the product signal against the oracle.
- `office-rewrite-stack-fixture.ts`/`office-editor-stack-fixture.ts` `documentServerReady` waits, which are unchanged.
- `docs/EMPLOYEE_GUIDE.md` §「Office 在线编辑的提示」 (employee-facing hint catalogue; must list the restart note).
- Docs that change with this: `deploy/README.md:23` (stand-in description), `deploy/README.md:43` (Compose evidence row: stand-in healthy through the inherited healthcheck plus the negative check), `platform/test/README.md:92` (local full-stack evidence row: restart note and health timeline), `docs/LOCAL_STACK.md:144` (hint lane shows two hints; disambiguate DS `/healthcheck` from Docker health).
- `container-document-server-fixture.ts` / `deployment-fixture.ts` (the stand-in image).
- External Document Server mode is out of scope.

Seams under test:

- `client.test.js`: the wrapper's rendered tree.
- `deployment-compose-fixture.integration.test.ts`: the override content.
- `deployment-document-server.docker.test.ts`: real Compose with the stand-in.
- `platform-stack.stack.test.ts`: the real DS image.

Required evidence:

- **Unit:** opening a docx/xlsx/pptx in a Session renders both `collab` (F40 text unchanged) and `restart` (exact text). The no-Session view renders neither `restart` nor the editor. The unloaded fallback renders no `restart`. Red: the `restart` assertions fail before the change.
- **Integration:** the override has no `healthcheck` key and its entrypoint ends in the `xargs tail -F` step. Red against the old override.
- **VPS `pnpm test:deploy`:** the stand-in's `State.Health.Status` becomes `healthy`, its `Config.Healthcheck.Test` equals `documentserver.healthcheck.test` in the delivered `deploy/compose.yml` (inherited, not overridden), and that exact command run inside `dsh-team-documentserver-net` (same platform image, no final step) under an outer `sh` that prints its exit code reports 1 or 2, while the `docker exec` CLI exits 0 (a nonzero CLI exit would leave the custody submission unsettled, and a daemon failure such as a missing container would be indistinguishable from grep's no-match). All existing checks pass.
- **Local `pnpm test:stack`:**
  - A sampler starts concurrently right after `compose up` (`platform-stack.stack.test.ts` ~:678), not at the existing `documentServerStarted` call (~:527, which runs after several lanes when the window is long over). It adds no deadline and is joined/settled before the existing wait.
  - Each sampler iteration reads `State.Health.Status` FIRST and runs the oracle `pgrep` SECOND. Assertion: a `healthy` sample implies that iteration's pgrep succeeds; reading in the other order produces false failures.
  - At least one sample has pgrep missing and status `starting`, and in that window `State.Health.Log` shows at least one probe entry with nonzero ExitCode, proving the probe ran and said no rather than never running.
  - Record `docserviceSpawns` at the first `healthy` sample and assert it equals the final count at the existing `:564` assertion.
  - The stack evidence line reports sample counts (before final step, healthy), the startup and healthy ms, and spawns.
  - the office-hints screenshot shows the restart note;
  - no new console errors.
- **Negative controls:** the platform image without the final step is checked by the deploy lane's `docker exec` in the firewall holder; the real image is checked by the stack lane's failing `Health.Log` entries before the final step.

Non-goals:

- Blocking or delaying instance start.
- Detecting the window in the browser.
- Changing `dsh-sidebar-onlyoffice`.
- Disabling `GENERATE_FONTS`.
- External DS readiness.
- The stale「Office 在线编辑尚未交付」wording (#666).

Review focus:

1. The probe cannot self-match and works in both images.
2. The stand-in is not a bypass.
3. The F40 and no-Session hints are byte-identical.
4. The health timeline assertion really orders "final step observed" before "healthy".
5. The DEPLOY.md procedure is executable as written (exact `docker inspect` command).
