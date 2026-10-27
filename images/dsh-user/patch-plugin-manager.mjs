// Build-time patch of the published plugin page (#375): remove its 「添加插件」 button and its
// detail-page uninstall button; switches, configuration cards, refresh and details are unchanged.
// Usage: node patch-plugin-manager.mjs "$(npm root -g)". Any drift refuses before writing.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const VERSION = '0.2.0-rc.2';
const SCOPE = '@deepseek-ai';
const PACKAGE = 'dsh-client-ui-plugin-manager';
// SHA-256 of the published lib/client.js (npm tarball) and of the reviewed patched result.
const INPUT_SHA256 = 'bf25686c575d598b91a5dec43cc725d9c1066c801555ce06e6f12f0f72e94f77';
const OUTPUT_SHA256 = 'ca954298bb89b27f93f49457500a7ef3758e64746a04bded0c83b24ccedf2bdc';

const tabs = (depth, text) => `${'\t'.repeat(depth)}${text}`;
// The page-header toolbar's last child; its only caller of openInstall.
const ADD_PLUGIN_BUTTON = [
  '(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {',
  tabs(8, 'variant: "primary",'),
  tabs(8, 'size: "sm",'),
  tabs(8, 'className: PluginManagerPage_module_css_default.addButton,'),
  tabs(
    8,
    'icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 13 }),',
  ),
  tabs(8, 'disabled: !loaded,'),
  tabs(8, 'onClick: props.openInstall,'),
  tabs(8, 'children: t(state.install.requestId === void 0 ? "addPlugin" : "installViewTask")'),
  tabs(7, '})'),
].join('\n');
// PackageDetail's actions: the whole conditional uninstall button.
const UNINSTALL_BUTTON = [
  'pkg.installed ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {',
  tabs(9, 'variant: "outline",'),
  tabs(9, 'size: "sm",'),
  tabs(9, 'className: PluginManagerPage_module_css_default.danger,'),
  tabs(
    9,
    'icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutlineRegular, { size: 13 }),',
  ),
  tabs(9, '"aria-label": t("uninstallLabel", { name: title }),'),
  tabs(9, 'disabled: busy || pkg.readOnlyReason !== void 0,'),
  tabs(9, 'onClick: onUninstall,'),
  tabs(9, 'children: t("uninstall")'),
  tabs(8, '}) : null'),
].join('\n');

/** Name the failed check only; never print paths or file contents. */
function refuse(check) {
  process.stderr.write(`patch-plugin-manager: refused: ${check}\n`);
  process.exit(1);
}

function versionOf(manifest, check) {
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version;
  } catch {
    return refuse(check);
  }
}

/** Real directories only: a symbolic link is neither followed nor counted. */
function findCopies(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === PACKAGE && basename(dir) === SCOPE) {
      const manifest = readdirSync(path, { withFileTypes: true }).find(
        (child) => child.name === 'package.json' && child.isFile(),
      );
      if (manifest !== undefined) found.push(path);
    }
    findCopies(path, found);
  }
  return found;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Same-directory temporary file and rename: the target is replaced whole or not at all. */
function replaceFile(target, text) {
  const temporary = `${target}.${String(process.pid)}.tmp`;
  let created = false;
  try {
    const { mode } = statSync(target);
    // `wx` never adopts an existing path; only a file this run created is removed on failure.
    writeFileSync(temporary, text, { flag: 'wx', mode: mode & 0o7777 });
    created = true;
    chmodSync(temporary, mode & 0o7777);
    renameSync(temporary, target);
  } catch {
    if (created) rmSync(temporary, { force: true });
    refuse('write');
  }
}

function main(root) {
  if (root === undefined) refuse('usage');
  if (versionOf(join(root, SCOPE, 'dsh', 'package.json'), 'dsh-version') !== VERSION) {
    refuse('dsh-version');
  }
  let copies;
  try {
    copies = findCopies(root);
  } catch {
    refuse('discovery');
  }
  if (copies.length !== 1) refuse('copy-count');
  const [copy] = copies;
  if (versionOf(join(copy, 'package.json'), 'plugin-manager-version') !== VERSION) {
    refuse('plugin-manager-version');
  }
  const target = join(copy, 'lib', 'client.js');
  let source;
  try {
    source = readFileSync(target, 'utf8');
  } catch {
    refuse('input-read');
  }
  if (sha256(source) !== INPUT_SHA256) refuse('input-sha256');
  const patched = source.replace(ADD_PLUGIN_BUTTON, 'null').replace(UNINSTALL_BUTTON, 'null');
  if (sha256(patched) !== OUTPUT_SHA256) refuse('output-sha256');
  replaceFile(target, patched);
}

main(process.argv[2]);
