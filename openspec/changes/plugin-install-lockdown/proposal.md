## Why

#375. The requirements baseline says employees can only switch approved, image-installed plugins on and off and cannot install any (D9). The plugin page shows only approved plugins and their switches, with no install entry (F46). Plugin install sources are closed (F47). The released DSH 0.2.0-rc.2 does not meet this:

- **The sidebar plugin page has install and uninstall entries.** `@deepseek-ai/dsh-client-ui-plugin-manager` (`lib/client.js`):
  - The 「添加插件」 button is rendered whenever the cards show, gated only by `!loaded` (`:3475`).
  - The detail page has an uninstall button gated only by `pkg.installed` (`:2437`).
  - Neither has a configuration switch.
- **The agent can install plugins.** The tool `@deepseek-ai/dsh-plugin-manager/tools` (`plugin_manager`: `install_bundle`, `remove_bundle`, …) is disabled globally but re-enabled inside the Web preset (`dsh-web-app/presets/cordis.patch.yml:152-154`). The managed overlay's `filterPlugins` (`platform/src/managed-config/generate.ts:69-82`) removes only the network tool.
- **The install dialog probes public registries.** The plugin page's host half probes npm and npmmirror while the dialog is open (`registryProbeEnabled`, default `true`; `lib/index.js:72`, `client.js:1130`).

The host `pluginManager` service has no option to refuse installs (`Config`, `dsh-plugin-manager/lib/index.js:1353-1362`).

The sidebar plugin page is also the only place where plugins can be switched. It hosts the configuration cards of the shell, agent-loop, subagent and web-search settings in its `plugins.item` slot. Hiding the page (issue option A) would therefore mean rewriting the switches and finding another home for those cards; the user rejected it.

The user's decision on #375 (issuecomment-6443404046):

- Q1: remove the agent tool in the overlay and turn off the registry probe.
- Q2: option C, a build-time patch of the plugin page that removes only the install and uninstall entries.
- `dsh plugin add` from the terminal is an accepted residual.

This is compliance and product behaviour, not a security boundary. Employees have a terminal and `danger-full-access` (#372).

## What Changes

- **Overlay (`platform/src/managed-config/generate.ts`):**
  - The preset filter also removes `@deepseek-ai/dsh-plugin-manager/tools` from every preset, nested groups included, matched by package name as for the network tool.
  - One row `{ id: 'ui-plugin-manager', config: { registryProbeEnabled: false } }`.
- **Build-time patch (`images/dsh-user/`):**
  - A small Node script, run as root in the user-image build, rewrites the single installed copy of `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`. It removes exactly two expressions:
    - the 「添加插件」 button;
    - the detail-page uninstall button.
  - Switches (plugin and bundle), configuration cards, refresh, details and every other control are unchanged.
  - The script refuses to run, and so fails the image build, unless all of these hold:
    - the DSH version and the plugin-page package version are the reviewed 0.2.0-rc.2;
    - exactly one installed copy exists;
    - the input and output SHA-256 equal the reviewed values.
  - The patched file stays root-owned and not writable by uid1001.
- **Docs and rules:**
  - `CONTEXT.md` and AGENTS.md extend the build-time-patch exception from `dsh-better-sidebar` to this one file. This is a patch of a published build artifact, not DSH source (D1).
  - `docs/REQUIREMENTS_BASELINE.md` F46 and `docs/DEPLOY.md` record the accepted residuals:
    - `dsh plugin add` from the terminal (D12);
    - bundles an employee installed before the upgrade stay installed and can only be switched.
- **Evidence:**
  - Overlay unit tests.
  - Patch-script integration tests on owned copies (the exact input gives the exact output; every refusal leaves the file unchanged).
  - A user-image Docker case for the installed file's hash and ownership.
  - The managed-policy Docker oracle rejects `plugin_manager` in any live preset, including a renamed employee-added copy.
  - A real-DSH browser observation in the first-use lane:
    - the plugin page shows no 「添加插件」 button and no uninstall button;
    - plugin switches are present and enabled;
    - one approved plugin's switch round-trips off and on.

## Triage

```text
Issue type: baseline compliance (existing gap, not a regression)
Fixture level: expanded (critical path images/dsh-user/, rule-file change, overlay)
Upstream suggested level: none given
Blast radius: every user image build; every instance's overlay (next start); the plugin page of every employee
Selected risk packs: Release / packaging / image build; Config / project setup; Legacy compatibility / migration; Error handling / partial outputs; Documentation; Auth / permissions (documented non-boundary)
Evidence floor: overlay unit tests; patch-script integration tests incl. refusals; exact-head VPS pnpm test:docker (user-image hash/ownership, managed-policy oracle, first-use plugin-page browser observation) with confirmed cleanup; pnpm test:deploy
```

## Impact

- **Changed files:**
  - `platform/src/managed-config/generate.ts` and its test;
  - `images/dsh-user/Dockerfile`, plus a new patch script in `images/dsh-user/`;
  - `platform/test/` (patch-script integration test, user-image, managed-policy and first-use Docker lanes);
  - `CONTEXT.md`, `AGENTS.md`, `docs/REQUIREMENTS_BASELINE.md`, `docs/DEPLOY.md`.
- **Critical path:** `images/dsh-user/` needs human white-box review of every diff line.
- **Not affected:** no DSH source, no platform route or schema, no new configuration, no dependency, no workflow change.
- The archive of `shared-browser-isolation` (#372) rides in this branch, because every PR needs exact-head Docker evidence.
