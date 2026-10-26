# Platform navigation

This dependency-free host plugin and classic-script Web client support **exactly DSH `0.2.0-rc.2`**. Inside each employee's DSH workbench they add one entry to the released left-sidebar list slot `sidebar.footer.action`, so every signed-in user can get back to the platform pages without a DSH source change (D1).

| Link     | Target               | Shown when                                           |
| -------- | -------------------- | ---------------------------------------------------- |
| 账号设置 | `/_platform/account` | always                                               |
| 管理后台 | `/_platform/admin`   | the instance was started for a current administrator |

Both are plain same-tab links. The wide sidebar shows text rows with DSH's own colour/radius variables; the collapsed 56px rail shows compact inline-SVG icons with `aria-label`/`title`. No external assets are loaded.

## Role flag

The platform's managed overlay inserts this plugin with `config: { admin }`, computed from the account row read (and identity-fenced) at instance start. The host half (`index.js`) normalises it (only a literal `true` counts) and, on every served page, pushes one `webserver/index-inject` row `{ kind: 'global', name: '__DSH_TEAM_PLATFORM_NAV__', value: { admin } }` — the same mechanism DSH's settings-models and shortcuts plugins use. The client reads that global synchronously while rendering and makes **no network request**, so lanes that open DSH directly stay free of console errors. A missing, non-object or non-boolean value shows only 「账号设置」.

The flag is fixed for the lifetime of the DSH process. A promotion or demotion is reflected at that user's next instance start; until then a demoted user may still see 「管理后台」, but the platform admin pages and APIs answer 403. The link is navigation only, never authority.

## Layout

The shipped footer cell is a single flex row sized for the Cordis plugin action. The entry registers with `order: 1` (after Cordis) and renders one scoped `<style>` element that stacks that cell (`:has(> [data-dsh-team-platform-nav]) { flex-direction: column }`) and supplies hover/focus styles; it does not target DSH's hashed class names. The Cordis action stays visible in both modes.

## Trusted delivery

Build the user image with all four narrow plugin named contexts:

```sh
docker build -f images/dsh-user/Dockerfile -t dsh-team-user \
  --build-context "zh-locale=$(pwd)/plugins/zh-locale" \
  --build-context "permission-tiers=$(pwd)/plugins/permission-tiers" \
  --build-context "office-agents=$(pwd)/plugins/office-agents" \
  --build-context "platform-nav=$(pwd)/plugins/platform-nav" images/dsh-user
```

The image copies `package.json`, `index.js` and `client.js` to root-owned mode `0444` files in the mode `0555` directory `/opt/dsh-team/platform-nav/`, outside the employee-writable `/data/home`, and fails the build unless the package's `@deepseek-ai/dsh` peer equals the installed `dsh --version`. The absolute overlay row resolves the adjacent manifest, whose `dsh.client.platform: "web"`, `./client` export and `@deepseek-ai/dsh-client-ui-sidebar` injection deliver the Web artifact; React comes from DSH's seeded runtime. Roll the image and managed overlay back together.

## Verification

- `pnpm test`: `index.test.js` (exactly one normalised global row for admin true/false/missing/non-boolean) and `client.test.js` (one footer registration, role-gated links in wide and rail modes, malformed globals, no fetch/console use).
- `pnpm test:docker` on giap-vps: the exact boot roster includes `@dsh-team/platform-nav`; an employee's real sidebar shows only 「账号设置」 and its click reaches `/_platform/account`; an administrator's shows both links and 「管理后台」 reaches `/_platform/admin`; the collapsed rail keeps both compact links; the image files are root-owned, read-only and peer-pinned.
