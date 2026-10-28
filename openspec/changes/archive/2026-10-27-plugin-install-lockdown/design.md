## Context

See proposal.md, Why. Facts from the published 0.2.0-rc.2 packages:

- The sidebar plugin page (`ui-plugin-manager`, entry in `dsh-web-app/cordis.patch.yml:300`) is a combined host and client package.
  - The client inject list is `slots, locale, remote, remote.pluginManager, remote.pluginInventory, remote.pluginRegistryProbe, configForms, layout`.
  - The host half provides only `pluginRegistryProbe`.
- `openInstall` has exactly one caller, the 「添加插件」 button. The install dialog and the registry probe (`client.js:1130`, inside `install.open`) are unreachable without it.
- The uninstall confirmation (`client.js:3535`) is reachable only from the detail-page uninstall button.
- A plugin switch writes the profile `cordis.patch.yml` (`dsh-plugin-manager/lib/index.js:881`). A bundle switch writes `dsh.profile.bundles` in the profile `package.json`. A switch on a plugin the managed overlay forces returns `"overridden"` (`:1658`), so the overlay stays authoritative.
- The user image installs DSH with `npm install -g` as root (`images/dsh-user/Dockerfile:7`). The package files live under `/usr/local/lib/node_modules`, outside the employee-writable profile and outside the profile seed.

Governing invariant: an employee has no UI or agent path to start a plugin install or uninstall, while plugin and bundle switches and the configuration cards behave exactly as before; the managed overlay stays authoritative over profile edits.

## Goals / Non-Goals

**Goals**

- No UI path or agent path an employee can use to start a plugin install or uninstall.
- Switches and configuration cards behave exactly as before.
- No runtime registry probe.

**Non-Goals**

- Blocking installs from the terminal (`dsh plugin add`, direct profile writes). Accepted residual, D12.
- Refusing installs in the host `pluginManager` service. It has no option for this, and wrapping a cordis service is unverified.
- Removing bundles an employee installed before the upgrade. They remain and can be switched off.
- The `dsh-better-sidebar` patch, which belongs to stage 2 task 2.7.

## Decisions

### 1. Patch the published build artifact, removing two expressions

The patch replaces the two `react_jsx_runtime.jsx(Button, …)` expressions with `null`:

- the add-plugin button in the page header row;
- `pkg.installed ? jsx(Button …uninstall…) : null` in `PackageDetail`.

`null` is a valid React child in both positions, so the surrounding arrays and props keep their shape. Dead code (the dialog and the confirmation) is left in place: a smaller patch is easier to review and re-verify on upgrade.

Alternatives considered:

- **Hide by CSS from a plugin.** Fails silently when class names change.
- **Disable the whole page.** Loses the switches and the configuration cards.
- **No-op `openInstall`.** The button stays visible, which fails F46.

### 2. Fail the build on any drift

The script takes one argument, the global module root (the Dockerfile passes `"$(npm root -g)"`, so the script itself spawns nothing and is testable on owned temporary trees). It checks, in order, and exits non-zero without writing on the first failure:

1. `<root>/@deepseek-ai/dsh/package.json` has version `0.2.0-rc.2`, a literal in the script. The Dockerfile's existing `dsh --version` gate stays as it is.
2. A recursive search of `<root>` finds exactly one `@deepseek-ai/dsh-client-ui-plugin-manager/package.json`, and its version is `0.2.0-rc.2`.
3. The SHA-256 of that copy's `lib/client.js` equals the reviewed input hash (`bf25686c…` as extracted from the npm tarball; the implementer confirms it inside the built image).
4. The two exact source fragments are replaced, and the SHA-256 of the result equals the reviewed output hash.

Pinning both hashes makes the result exact: a separate fragment-count check would be redundant. The script then writes the result through a temporary file in the same directory and an atomic rename, keeping the original mode and root ownership.

- **Write failure.** If the write or the rename fails, the script removes the temporary file and exits non-zero. The target is never partially written.
- **Discovery.** The search walks real directories under the module root with `lstat` and does not follow symbolic links. A fresh global install contains no linked package directories, and a linked copy would be an unreviewed layout. It counts `@deepseek-ai/dsh-client-ui-plugin-manager/package.json` matches; zero or more than one is a refusal.
- **Diagnostics.** The script writes them with `process.stderr.write`, because ESLint's `no-console` rule applies to `.mjs` files too. They name the failed check and never print file contents.

**Test split.** The published `client.js` is not vendored. Fetching it in an integration test would make the test depend on the network.

- The refusal paths are tested on owned synthetic trees: versions, copy count, and an input hash mismatch, which any synthetic file triggers.
- The success path is proven on the real file: by the real image build, by the user-image Docker case checking the installed output hash, and by the browser observation.

The script is Node ESM using built-ins only (`node:crypto`, `node:fs`, `node:path`), because Node is the image's runtime. Python remains for DOCX only. It lives in the existing `images/dsh-user` primary build context: no new named context, so every builder and documented build command stays unchanged. It runs through a BuildKit `RUN --mount=type=bind` of that context file, so the script never becomes an image file or layer. The builds already require BuildKit for named contexts.

### 3. Overlay: same mechanism as the network tool

- `filterPlugins` matches a set of package names `{ '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-plugin-manager/tools' }`. Ids are employee-renamable, names are what load.
- The registry probe row `{ id: 'ui-plugin-manager', config: { registryProbeEnabled: false } }` sits with the trailing policy rows after the locale patch (`generate.ts:169`), so profile and locale edits cannot replace it. That entry has no config upstream, and a patch replaces a row's whole `config`, so the overlay value is the whole config.
- Once the button is gone nothing in the browser can show the probe setting (`fastest()` is reached only through `openInstall`). The live read of the `ui-plugin-manager` entry's config in the managed-policy observer is therefore its only runtime evidence, and it is mandatory.

## Risks / Trade-offs

- **[Upgrade drift]** A new DSH version changes `client.js`, so the build fails. → Intended. The upgrade procedure re-verifies the patch, as for `dsh-better-sidebar` (`docs/IMPLEMENTATION_PLAN.md` T6).
- **[Combined-script caching]** DSH might serve a cached combined client script that predates the patch. → The combined script is built at runtime from installed packages, and nothing writes a cache: `dsh-web-frontend/dist` has no copy, and `--dump-default-config` does not boot Web. Only the browser lane observes what is actually served. The user-image case hashes the installed file.
- **[Residual copy]** The page intro and info text still mention installing (「安装、启用和配置插件」). → Accepted, recorded with the residuals in F46.
- **[Devtools]** The host `pluginManager` remote calls stay reachable from browser devtools. → Accepted, recorded with the terminal residual.
- **[Existing volumes]** Employees in the acceptance environment who installed bundles keep them. → Documented in DEPLOY. An administrator reset restores the profile seed.
- **[Agent via terminal]** The agent can still run `dsh plugin add` through bash in Yolo. → Same residual as the terminal; documented.

## Migration Plan

- Deploy as an ordinary image and platform upgrade. The overlay applies at each instance's next start; the patched page applies once the instance runs the new image.
- Rollback: the previous image and platform version.

## Must preserve

- Every existing overlay row byte-for-byte, apart from the new row and the filtered preset entries. Existing exact-row assertions are updated, not weakened.
- The network-tool filtering semantics and their tests.
- Plugin and bundle switches, `readOnlyReason` gating, configuration cards in `plugins.item`, refresh, details, the settings 「内置插件」 inventory.
- Profile seed equality and permissions (user-image profile-seed case). The patch touches no file under `/data/home`.
- All four named build contexts and the documented build commands, unchanged.
- Zero unexpected browser console errors in the first-use lane.

## Review focus (critical-path human review)

- The pinned input and output SHA-256 literals, and the two exact replaced fragments.
- The atomic write: temporary file in the same directory, the rename, mode and root ownership kept, and the temporary file removed on failure.
- Placement in the `USER root` section of the Dockerfile.
- The `--mount=type=bind` invocation, and that the script is absent from the final image.

## Sibling surfaces

- Every builder of the user image: the Docker test helpers, the deployment helper and the documented `docker build` commands. All use the `images/dsh-user` primary context; the script lives there.
- The managed-policy oracle `NETWORK_TOOLS` set and its `customPresetFailure` controls (`managed-policy-oracle.ts:280-289`), the oracle integration test (`managed-policy-oracle.integration.test.ts`), the observer (`managed-policy-observer.js`) and the employee-edit fixture (renamed nested tools).
- `container-start-fixture.ts` presets input. The `admin-config-activation` lane's overlay-row assertions.
