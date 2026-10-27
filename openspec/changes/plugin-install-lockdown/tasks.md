## Risk packs

- **Release / packaging / image build — selected.** A new build step on a critical path. Drift must fail the build (task 1.3). Every builder keeps working through the unchanged primary context (task 1.4). The patched file is checked inside the real image (task 1.5).
- **Config / project setup — selected.** Overlay filter and probe row. Tasks 1.1 and 1.2. The live composition is checked in the managed-policy lane (task 1.6).
- **Legacy compatibility / migration — selected.**
  - Existing volumes keep bundles an employee installed before; they are documented, not migrated (task 1.8).
  - The overlay applies at the next start.
  - The profile seed is untouched (task 1.5 keeps the existing seed-equality case green).
- **Error handling / partial outputs — selected.** Every refusal leaves the target byte-identical; the write is atomic. Task 1.3.
- **Auth / permissions — selected, documentation only.** This is not a security boundary: terminal and `danger-full-access` remain (D12, #372). The residuals are recorded in task 1.8, and the file's root ownership is checked in task 1.5.
- **File IO / path safety / overwrite — selected.** The script replaces a root-owned file under `node_modules` through a temporary file and an atomic rename. It keeps mode and ownership and removes the temporary file if the write or rename fails (design §2). Tasks 1.3 and 1.5.
- **Resource limits / discovery — selected.** A recursive `lstat` walk of the global module root that does not follow symbolic links (design §2). Tasks 1.3 (zero and two copies, a symlinked copy not counted) and 1.4 (the real tree).
- **Documentation — selected.** Task 1.8.
- **Not selected:**
  - public API / HTTP: no route or schema change;
  - schema / DB: none;
  - concurrency: none;
  - performance: two expressions removed.

## Must preserve

See `design.md`, "Must preserve".

## 1. Implementation (tests first)

- [ ] 1.1 `generate.test.ts`, written first:
  - Input presets carry `@deepseek-ai/dsh-plugin-manager/tools` at the top level and inside a nested group, under arbitrary ids, next to the network tool. Both are removed; other entries, order and metadata are kept; the input is not mutated.
  - The output contains exactly one `{ id: 'ui-plugin-manager', config: { registryProbeEnabled: false } }` row.
  - Existing exact-row assertions are updated, not weakened.
- [ ] 1.2 `generate.ts`:
  - `filterPlugins` matches a set of removed package names.
  - Add the probe row with the trailing policy rows after the locale patch (design §3).
  - Update any other exact overlay-row assertion the new row breaks (search `platform/test` for full-overlay equality, e.g. the `admin-config-activation` and `container-start` lanes).
- [ ] 1.3 Patch script `images/dsh-user/patch-plugin-manager.mjs` (design §1–2), with an integration test `platform/test/plugin-manager-patch.integration.test.ts` written first. The test spawns `node` on the script against owned temporary synthetic module roots. It never fetches from the network and never vendors the published file (design, Test split).
  - Refusals, each with a non-zero exit and every file in the tree byte-identical:
    - the DSH package version differs;
    - zero copies;
    - two copies (top level and nested);
    - the plugin-manager version differs;
    - the input hash differs.
    - a copy reachable only through a symbolic link is not counted: with the real copy absent, the result is the zero-copy refusal.
  - Errors name the failed check without dumping file contents. Diagnostics go through `process.stderr.write`, because ESLint `no-console` applies to the script.
  - `images/` is outside test pairing, knip and coverage. This subprocess test plus `pnpm lint` is the script's only repository gate; say so in the PR.
  - The pinned input and output hashes are confirmed from the real published file before commit. Record in the report:
    - the input file's SHA-256 inside a locally built image, which must equal `bf25686c…`;
    - the output SHA-256;
    - a `node --check` of the patched file;
    - a grep showing both removed expressions gone and `EnableSwitch` intact.
  - The success path is proven by tasks 1.5 and 1.7.
- [ ] 1.4 `images/dsh-user/Dockerfile`: in the existing `USER root` section, after the profile-seed copy and before the final `USER dsh` (the early version gate runs as `dsh` and cannot write `/usr/local`), run `RUN --mount=type=bind,source=patch-plugin-manager.mjs,target=/tmp/patch-plugin-manager.mjs node /tmp/patch-plugin-manager.mjs "$(npm root -g)"`. Placement keeps the image's existing user switching. The script is absent from the final image.
- [ ] 1.5 `platform/test/user-image.docker.test.ts` (existing lifecycle and cleanup), one case:
  - the installed `client.js` SHA-256 equals the pinned patched value;
  - it is owned by root and not writable by uid1001 (an actual write attempt as `dsh` fails);
  - `/tmp/patch-plugin-manager.mjs` is absent;
  - existing profile-seed cases stay green unchanged.
- [ ] 1.6 Managed-policy Docker lane and oracle:
  - The oracle rejects `plugin_manager` in any live preset's tool names, alongside `NETWORK_TOOLS`.
  - The employee-edit fixture adds a renamed nested `@deepseek-ai/dsh-plugin-manager/tools` in its custom preset.
  - Before/after control, following `customPresetFailure` (`managed-policy-oracle.ts:280-289`): a new `custom-plugin-manager` control failure requires that the employee's custom preset shows `plugin_manager` live in the unmanaged control phase. With the overlay it must be absent.
  - `managed-policy-oracle.integration.test.ts`: a `plugin_manager` rejection case beside the forbidden network-tool case (`:46`), plus the new control failure.
  - Mandatory live read: the observer reads the `ui-plugin-manager` entry's config from `ctx.loader.entries()` (as at `managed-policy-observer.js:31-38`, `:111-119`). The oracle requires `registryProbeEnabled: false` in the managed phase. This is the only runtime evidence for that row (design §3).
- [ ] 1.7 Real-DSH browser observation, in the first-use lane (`platform/test/first-use.docker.test.ts`, which already observes the sidebar) or in a new case that reuses its helpers and lifecycle:
  - **Installed-bundle setup (one owned control for both uninstall and switch).** The delivered profile lists `@dsh-team/office-agents` only in `dsh.profile.bundles`, with empty `dependencies`. `listBundles` therefore reports it `installed:false`, and the page builds no card for it (`dsh-plugin-manager/lib/index.js:1469-1510`, `dsh-client-ui-plugin-manager/lib/client.js:3342`). So no package shows an uninstall button or a switch, patched or not.
    - Use a dedicated employee, not the lane's untouched first-use employee. Follow the managed-policy `employee-edited` pattern. The home volume fills from the image only on its first mount, so the edit cannot happen before the first start:
      1. start the instance and stop it;
      2. as uid1001, add `"@dsh-team/office-agents"` to the profile `package.json` `dependencies`;
      3. start it again.
         The bundle's files, exact peer pin and real `dsh.bundle.patch` are already in the image. No network install.
    - The implementer first confirms on the real image that profile boot accepts this hand-added entry with no lockfile row, with zero unexpected boot errors. If it does not, stop and report rather than inventing another package shape.
    - Precondition, asserted: a card `[data-plugin-package="@dsh-team/office-agents"]` inside `[data-plugin-group="bundles"]` (heading 「已安装」), with `data-plugin-status` not `problem`. This implies `installed:true` given `client.js:3342-3343`. Select on these attributes.
  - **Add-plugin positive control.** Open the sidebar plugin panel (`sidebar.panellist` id `plugins`) and wait for the cards to load. The refresh button in the same toolbar (`client.js:3448-3469`) must be visible. Then: no 「添加插件」/`Add plugin` button.
  - **Uninstall.** Open the office-agents detail: no 「卸载」/`Uninstall` button; its switch is present and enabled (no `readOnlyReason`; the overlay does not force it).
  - **Switch round-trip.** Switch office-agents off; after a page reload the card's switch is off. Switch it on; after a reload it is on. "Read back" means exactly this DOM state after a reload.
    - While it is off, the office presets and `office-delegation` leave the live composition. This is expected and not asserted further.
    - Any console error raised in that state is a real finding and must not be allowlisted. A `restart-required` toast is not a console error.
  - **Restore.** Before any later step or volume-reuse sentinel of the lane, restore both the switch state (on) and the profile `dependencies` (the entry removed). Assert the profile `package.json` content equals its pre-test bytes; DSH's own save may change the file mode to `0600`, which is not asserted. A byte difference is a real failure to report.
  - Zero unexpected console errors. Reuse the lane's existing observation and screenshot conventions.
- [ ] 1.8 Docs:
  - `CONTEXT.md:24`: the build-time-patch exception covers `dsh-better-sidebar` (stage 2, not yet in the production image) and the install and uninstall entries of `@deepseek-ai/dsh-client-ui-plugin-manager`. A version mismatch fails the build.
  - AGENTS.md: one sentence in the user-image Docker paragraph (patch, hash pin, refusal, evidence). Important Development Note 6 stays as it is.
  - `docs/REQUIREMENTS_BASELINE.md` F46: append the accepted residuals:
    - the terminal is kept (D12), so `dsh plugin add` and direct profile writes remain possible and do not count as a D9 violation;
    - the plugin-management calls stay reachable from browser devtools;
    - the page's intro text still mentions installing.
  - `docs/DEPLOY.md`: in the user-image section, one paragraph covering:
    - the plugin page has no install or uninstall entry;
    - the agent has no plugin tool;
    - bundles an employee installed before this upgrade stay and can only be switched off, and an administrator reset restores the profile seed;
    - the terminal residual.

## 2. Verification

- [ ] 2.1 `pnpm check`; `pnpm test:integration platform/test/plugin-manager-patch.integration.test.ts`.
- [ ] 2.2 Exact-head VPS: `pnpm test:docker` with confirmed cleanup (user-image, managed-policy and first-use cases included), and `pnpm test:deploy`; CI green. After merge, redeploy the acceptance environment, and in the real UI check that the plugin page has no install entry.

## Non-goals

See `design.md`.
