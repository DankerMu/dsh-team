# Knowledge base

This dependency-free host plugin and classic-script Web client support **DSH `0.2.1-rc.2`** through the manifest range `engines.dsh: >=0.2.1-rc.2 <0.3.0`; the manifest declares no `@deepseek-ai/dsh` peer. It will give employees the 「知识库」 sidebar panel, the composer scope control and the retrieval tool over the platform's RAGFlow proxy (stage 2, group 15).

## Scope of 15.1

This first slice delivers only the skeleton, the image delivery and the catalog registration; it adds no interface and no tool and changes no existing behaviour.

- The host half (`index.js`, plugin name `dsh-team-knowledge-base`) validates its config (below) and registers nothing. Reading `DSH_TEAM_INSTANCE_TOKEN` and registering the plugin's routes belong to 15.2.
- The client half (`client.js`) loads one classic-script registration `@dsh-team/knowledge-base` whose `apply` injects no service, registers no slot, sends no request and writes nothing to the console. It exists so this image change proves the client half reaches the browser through the bundle layer; the panel (15.2) and the scope control (15.3) are added later.
- The plugin code, manifest and patch hold no RAGFlow address, key or retrieval parameter. The RAGFlow key stays in the platform backend; the plugin only ever talks to the platform.

## Config contract

The bundle patch (`cordis.patch.yml`) is exactly one insert row, `{ id: knowledge-base, name: /opt/dsh-team/knowledge-base/index.js }`, without `config` or override rows. The managed overlay (#447) targets that id with `{ id: 'knowledge-base', config: { platformUrl } }` in network mode.

- No platform address is a designed state, not an error: a `config` that is `undefined`, `null` or a plain object without own keys makes `apply` do nothing. This is the state in `published-loopback` mode, where the overlay writes no `knowledge-base` config row; in network mode the overlay always gives `platformUrl` (#447).
- With an address, `config` is exactly `{ platformUrl }`: the string `http://<canonical dotted IPv4>:<port>`, whose last octet is 3 modulo 16 (the instance bridge's +3 platform address, the same rule the generator applies to +2), with a decimal port 1..65535 without leading zeros, and no path (a trailing `/` included), query, fragment or user information.
- Any other shape (an extra or symbol key, a non-string or accessor value, a malformed or non-+3 address, an array or a non-plain object) makes `apply` throw a `TypeError` with a fixed message that does not echo the input. The whole plugin then fails to load, which the existing plugin-failure marker checks report, as with a tampered `platform-nav` row.

The row name is an absolute `/opt` path rather than the package name: when the overlay forces the entry on in a profile without its registered copy (a home volume created before stage 2, or one whose copy an employee uninstalled natively), it writes this whole patch, and only the absolute path resolves there, to the root-owned canonical copy; the adjacent manifest still delivers the client half.

## Trusted delivery

Build the user image with all five narrow plugin named contexts:

```sh
docker build -f images/dsh-user/Dockerfile -t dsh-team-user \
  --build-context "zh-locale=$(pwd)/plugins/zh-locale" \
  --build-context "permission-tiers=$(pwd)/plugins/permission-tiers" \
  --build-context "office-agents=$(pwd)/plugins/office-agents" \
  --build-context "platform-nav=$(pwd)/plugins/platform-nav" \
  --build-context "knowledge-base=$(pwd)/plugins/knowledge-base" images/dsh-user
```

The image copies `package.json`, `index.js`, `client.js` and `cordis.patch.yml` to root-owned mode `0444` files in the mode `0555` directory `/opt/dsh-team/knowledge-base/`, outside the employee-writable `/data/home`. The catalog lists it as the manageable item `knowledge-base` (「知识库」) with `imageDefaultEnabled: true`, so `catalog-check.mjs register` copies it into the Web profile as the installed dependency `file:/opt/dsh-team/knowledge-base` and appends it to `dsh.profile.bundles` in catalog order, before the office bundle. The build fails unless the installed DSH satisfies `engines.dsh` and the profile copy equals the canonical copy byte for byte. Its enablement follows only the catalog's three states: `employee` (the default) leaves the employee's plugin-page switch in charge, and the overlay's catalog rows force `forced-on`/`forced-off` (#407).

Legacy home volumes: Docker seeds the profile only into an empty home volume. An employee whose home volume existed before this image has no registered copy and no bundle membership, so in the `employee` state they have no knowledge base until an administrator resets their profile, like the office bundle. `forced-on` loads it on those volumes through the absolute path row.

## Verification

- `pnpm test`: `index.test.js` (the plugin name; `undefined`, `null`, `{}` and a prototype-free empty object leave the host untouched; valid +3 addresses including ports 1 and 65535 and last octets 3, 19 and 243; a fixed `TypeError` without the input for every rejected shape listed above; the manifest and the single config-free insert row) and `client.test.js` under jsdom (exactly one `__ModuleLoader__.load` with the package id; no injected service, slot, request, console output or DOM node).
- `pnpm test` and `pnpm test:integration`: the catalog consumers (`catalog-check`, the catalog module, the administrator catalog API, the build-rejection contexts and the plugin-page evidence module) on the five-entry catalog.
- `pnpm test:docker` on giap-vps: `/opt/dsh-team/knowledge-base/` holds exactly the four files, root-owned and read-only, which uid1001 cannot write, create or rename; the manifest is compatible and peer-free with a `./client` export; the profile bundles are `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @dsh-team/knowledge-base, @dsh-team/office-agents]`; the managed-policy instance's exact boot roster includes `@dsh-team/knowledge-base`, its logs carry no plugin-failure marker and its loader holds the `knowledge-base` row enabled and active; the first-use plugin page shows the knowledge-base card `running` with its switch visible; stored RAGFlow sentinels appear neither in the instance environment, its overlay, the canonical files nor the profile copy.
