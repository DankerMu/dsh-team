# Platform navigation

This dependency-free host plugin and classic-script Web client support **DSH `0.2.1-rc.2`** through the manifest range `engines.dsh: >=0.2.1-rc.2 <0.3.0`. Inside each employee's DSH workbench they add one entry to the released left-sidebar list slot `sidebar.footer.action`, so every signed-in user can get back to the platform pages without a DSH source change (D1).

| Link     | Target               | Shown when                                           |
| -------- | -------------------- | ---------------------------------------------------- |
| 账号设置 | `/_platform/account` | always                                               |
| 管理后台 | `/_platform/admin`   | the instance was started for a current administrator |

Both are plain same-tab links. The wide sidebar shows text rows with DSH's own colour/radius variables; the collapsed 56px rail shows compact inline-SVG icons with `aria-label`/`title`. No external assets are loaded.

On DSH's own plugin page the client also shows every administrator-forced catalog item as locked (see [Locked plugin cards](#locked-plugin-cards)).

## Page global

The platform's managed overlay inserts this plugin with `config: { admin, pluginCatalog }`, computed at instance start. `admin` comes from the account row read (and identity-fenced) then. `pluginCatalog` maps each catalog package name whose administrator state is `forced-on` or `forced-off` to that state, in catalog file order: the required items are always `forced-on`, and `employee` items are absent.

The host half (`index.js`) normalises `admin` (only a literal `true` counts). A missing `pluginCatalog` (an older admin-only row) counts as `{}`. A present one must be a plain object whose keys match `^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$` and whose values are one of the two states; anything else makes `apply` throw a `TypeError` that does not echo the input. The whole plugin then fails to load, sidebar links included. That is a deliberate loud failure: the generator only writes valid rows, and the existing plugin-failure checks catch a tampered one. On every served page the host half pushes one `webserver/index-inject` row `{ kind: 'global', name: '__DSH_TEAM_PLATFORM_NAV__', value: { admin, pluginCatalog } }`, the same mechanism DSH's settings-models and shortcuts plugins use. The client reads that global synchronously and makes **no network request**, so lanes that open DSH directly stay free of console errors. A missing, non-object or non-boolean `admin` shows only 「账号设置」.

The flag is fixed for the lifetime of the DSH process. A promotion or demotion is reflected at that user's next instance start; until then a demoted user may still see 「管理后台」, but the platform admin pages and APIs answer 403. The link is navigation only, never authority.

## Locked plugin cards

DSH 0.2.1-rc.2's plugin page has no slot for a card or its switch, and its own read-only lock (`readOnlyReason`) is reserved for the bundle that carries the plugin manager. The client therefore decorates the released DOM without replacing it. When the page global names at least one valid forced package, it:

- appends **one** `<style data-dsh-team-plugin-lock>` to `document.head`. For each forced package P it holds exactly two `display: none !important` rules: `[data-plugin-package="P"] button[role="switch"]` (the card's bundle switch) and `[data-plugin-detail="P"] > :first-child button[role="switch"]:last-of-type` (the last switch in the detail page's top action row, which is the bundle switch). `:last-of-type` keeps matching after the mark is inserted behind the switch; `:last-child` would stop matching and show the native switch again. The detail page's row switches below are not matched.
- inserts exactly one non-interactive `<span data-dsh-team-plugin-lock="forced-on|forced-off">` right after each hidden switch, reading `已开启 · 由管理员设定` or `已关闭 · 由管理员设定`. A parent that already holds a mark gets no second one. The client inserts only its own nodes and never changes or removes a node or attribute DSH rendered, including `data-plugin-status` and `aria-checked`.
- scans the page once, then keeps one `MutationObserver` on `document.body` (`childList`, `subtree`). Because required items are always forced on, it stays resident on every DSH page, chat streaming included. Each callback looks only at added element nodes. An added node that is not inside or does not contain a `[data-plugin-package]`/`[data-plugin-detail]` element is skipped without a whole-document query; otherwise only that added subtree is searched for the forced switches.

A missing, malformed or empty `pluginCatalog` adds no catalog style and no catalog marks, and the client never throws over it; the observer and the sandbox style below exist regardless. A hidden switch cannot be clicked or focused, so a forced card has no control that could call `pluginManager.setBundleEnabled`. The native 「添加插件」, update and uninstall entries, `employee` items and packages outside the catalog are unchanged.

## Locked HTML preview sandbox switches

dsh-better-sidebar 0.28.0's HTML viewer settings carry two toggles, `htmlViewerNoSandbox` and `htmlViewerDefaultUnsafe`, rendered as a `<label>` holding `<input type="checkbox" aria-label={title}>` with no key in the DOM. The client locks both unconditionally (product policy F36): no page global or overlay input is read.

- One `<style data-dsh-team-plugin-lock="html-sandbox">` is appended before anything renders. It holds `label:has(> input[aria-label="<title>"]){display:none !important}` for the zh titles 「关闭 HTML 预览沙箱（不安全）」「HTML 预览默认以非沙箱模式打开（不安全）」 and their en titles, so no clickable switch flashes. The catalog style's guard matches only `[data-dsh-team-plugin-lock=""]`.
- A `<span data-dsh-team-plugin-lock="html-sandbox">沙箱开启 · 由管理员设定</span>` is inserted after each matched label (not inside it), once per toggle row.
- The same single observer also searches an added subtree that holds one of those inputs: one `querySelector` per added element, never a whole-document query.

The lock is display only. The sandbox guarantee is the preview route's own CSP (`sandbox` without `allow-same-origin`) and the gateway's CSP on `/sidebar/file`; an employee who writes either key in the profile, or clicks the status bar's temporary unlock, removes only the iframe's `sandbox` attribute. Titles are matched in zh and en only; zh-locale selects zh on every load. A changed title in a later better-sidebar release silently drops the lock, which the Docker case catches.

Accepted residuals:

- The install wizard's `enableInstalled` and the update reinstall path call `setBundleEnabled(name, true)`. An employee can reach them by uninstalling a forced item through the retained native uninstall entry and adding it back. The effective state is still the overlay's; only the display and the profile list change.
- The row switches on a forced bundle's detail page remain clickable. The overlay is applied last at the next start and on runtime recomposition, so the change has no effect.
- The native uninstall entry stays on forced items; uninstalling a forced-on item's profile copy does not stop its overlay activation.
- A card's `data-plugin-status` still reflects profile membership, not the effective state.
- A plugin that renders a switch inside its own container in the `plugins.detail.actions` slot, as that container's last `<button>`, would also be hidden. No delivered plugin does.
- The DOM contract is bound to DSH 0.2.1-rc.2's attributes and structure; the first-use Docker case re-verifies it after a DSH upgrade.

## Layout

The shipped footer cell is a single flex row sized for the Cordis plugin action. The released renderer places every `sidebar.footer.action` entry inside a `display: contents` anchor `<div data-slot="sidebar.footer.action">`, so the entry is not a direct child of that cell. The entry registers with `order: 1` (after Cordis) and renders one scoped `<style>` element that selects the real cell through that stable anchor and stacks it (`:has(> [data-slot="sidebar.footer.action"] > [data-dsh-team-platform-nav]) { flex-direction: column; align-items: center }`), plus hover/focus styles; it does not target DSH's hashed class names. The released Cordis badge renders only while Cordis lists at least one plugin or has an active run (`dsh-client-ui-cordis` returns no element otherwise); without it the cell holds only this entry. When the badge is present the entry stacks below it: in the wide sidebar both fill the cell's width, and in the collapsed rail both 36px items are centred one above the other.

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

The image copies `package.json`, `index.js`, `client.js` and `cordis.patch.yml` to root-owned mode `0444` files in the mode `0555` directory `/opt/dsh-team/platform-nav/`, outside the employee-writable `/data/home`, and fails the build unless the installed DSH satisfies the package's `engines.dsh` range under DSH's own `semver` (prereleases included); the manifest declares no `@deepseek-ai/dsh` peer. The absolute overlay row resolves the adjacent manifest, whose `dsh.client.platform: "web"`, `./client` export and `@deepseek-ai/dsh-client-ui-sidebar` injection deliver the Web artifact; React comes from DSH's seeded runtime. Roll the image and managed overlay back together.

The manifest declares `dsh.bundle.patch: ./cordis.patch.yml`, a layer with no rows. It exists only so the released plugin page lists the package: `catalog-check.mjs register` copies `/opt/dsh-team/platform-nav/` into the Web profile and records it as the installed dependency `file:/opt/dsh-team/platform-nav`, unselected. Activation stays with the overlay's absolute `/opt` row; an employee selecting the bundle adds no row.

## Verification

- `pnpm test`: `index.test.js` (exactly one normalised global row for admin true/false/missing/non-boolean, forced states published in order, a `TypeError` without the input for each malformed `pluginCatalog`) and `client.test.js` under jsdom (one footer registration, role-gated links in wide and rail modes, malformed globals; no style or observer without valid forced states; exactly one style with two rules per forced package; marks after card and detail switches whether the page renders before or after the client, without duplicates on repeated mutations; the detail switch stays `display: none` after its mark; DSH nodes and attributes unchanged; only added subtrees queried while unrelated content streams in; no fetch/console use).
- `pnpm test:integration platform/test/probe-plugin-page.integration.test.ts`: the plugin-page evidence module against a scripted page, including every lock rejection.
- `pnpm test:docker` on giap-vps: the exact boot roster includes `@dsh-team/platform-nav`; an employee's real sidebar shows only 「账号设置」 and its click reaches `/_platform/account`; an administrator's shows both links and 「管理后台」 reaches `/_platform/admin`, which shows a 「返回工作台」 link to `/`; starting from DSH's initial sidebar mode (the 800×600 verification window opens with the rail) the probe toggles to the other mode and back, and in both wide and rail modes the entry is the slot anchor's child, its footer cell is in the viewport with computed `flex-direction: column; align-items: center` (proof that the `:has()` rule selects the real cell), every link is horizontally inside the cell and wide labels are not truncated; these lanes list no Cordis plugin and start no run, so the badge is absent (when present it must share the cell with the entry below it); the image files are root-owned, read-only and peer-pinned.
- `pnpm test:docker` first-use plugin page on giap-vps: the three required cards are locked forced on (native switch present but unrendered with no client rects, exactly one matching mark), CDP Tab traversal reaches every locked card but never its switch while the office switch is reached, a real pointer click on a mark followed by Enter and Space and a reload leaves the mark and `aria-checked` unchanged, a required item's detail page keeps its top switch unrendered with the mark as its next sibling and the uninstall entry present, and the office bundle still switches and persists. Screenshots: list, locked, locked-detail, detail and each switch leg.
