import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { main, patchPackage, PINS } from './patch-package.mjs';

const NAME = 'dsh-team-synthetic-package';
// A content marker: no refusal may echo the file it guards.
const MARK = 'DSH_TEAM_SYNTHETIC_CONTENT_MARKER';
const SOURCE =
  `// ${MARK}\nconst SECRET = "public-constant";\n` +
  'function derive(input) {\n\treturn input;\n}\n';
const REPLACEMENTS = [
  ['const SECRET = "public-constant";', 'const SECRET = process.env.SYNTHETIC_SECRET ?? "";'],
  ['function derive(input) {\n', 'function derive(input) {\n\tif (SECRET === "") return null;\n'],
];
// The reviewed result, written out by hand rather than derived by the code under test.
const PATCHED =
  `// ${MARK}\nconst SECRET = process.env.SYNTHETIC_SECRET ?? "";\n` +
  'function derive(input) {\n\tif (SECRET === "") return null;\n\treturn input;\n}\n';
// A second target of the same package; the replacements apply to every target.
const SECOND = 'lib/client.js';
const SECOND_SOURCE = `// second\n${SOURCE}`;
const SECOND_PATCHED = `// second\n${PATCHED}`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const owned = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writePackage(
  directory,
  { version = '1.0.0', source = SOURCE, second = null, name = NAME } = {},
) {
  mkdirSync(join(directory, 'lib'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version }));
  if (source !== null) writeFileSync(join(directory, 'lib/index.js'), source, { mode: 0o444 });
  if (second !== null) writeFileSync(join(directory, SECOND), second, { mode: 0o444 });
}

/** An owned /opt-like root holding the expected copy, beside an empty global root. */
function imageTree(contents) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-team-patch-package-'));
  owned.push(base);
  const opt = join(base, 'opt');
  const global = join(base, 'global');
  mkdirSync(opt);
  mkdirSync(global);
  const copy = join(opt, NAME);
  if (contents !== null) writePackage(copy, contents);
  return {
    base,
    opt,
    global,
    copy,
    target: join(copy, 'lib/index.js'),
    second: join(copy, SECOND),
  };
}

const target = (overrides = {}) => ({
  target: 'lib/index.js',
  inputSha256: sha256(SOURCE),
  outputSha256: sha256(PATCHED),
  ...overrides,
});
const secondTarget = (overrides = {}) => ({
  target: SECOND,
  inputSha256: sha256(SECOND_SOURCE),
  outputSha256: sha256(SECOND_PATCHED),
  ...overrides,
});

function options(tree, overrides = {}) {
  return {
    name: NAME,
    expected: tree.copy,
    version: '1.0.0',
    targets: [target()],
    replacements: REPLACEMENTS,
    roots: [tree.opt, tree.global],
    ...overrides,
  };
}

/** Relative path -> kind, mode and content digest of every entry; symlinks are not followed. */
function snapshot(root, prefix = '') {
  return readdirSync(join(root, prefix))
    .sort()
    .flatMap((name) => {
      const path = join(prefix, name);
      const stat = lstatSync(join(root, path));
      const entry = { path, mode: stat.mode & 0o7777 };
      if (stat.isDirectory()) return [{ ...entry, kind: 'directory' }, ...snapshot(root, path)];
      if (stat.isSymbolicLink()) return [{ ...entry, kind: 'symlink' }];
      return [{ ...entry, kind: 'file', sha256: sha256(readFileSync(join(root, path))) }];
    });
}

function run(input, io = {}) {
  const chunks = [];
  const status = patchPackage(input, { ...io, stderr: (text) => chunks.push(text) });
  return { status, stderr: chunks.join('') };
}

/** Nonzero, only the check name, and every file of the tree byte-for-byte as before. */
function expectRefused(tree, input, check, io = {}) {
  const before = snapshot(tree.base);

  const result = run(input, io);

  expect(result).toEqual({ status: 1, stderr: `patch-package: refused: ${check}\n` });
  expect(result.stderr).not.toContain(tree.base);
  expect(result.stderr).not.toContain(MARK);
  expect(snapshot(tree.base)).toEqual(before);
}

it('replaces the single real copy with the reviewed output, keeping its mode and leaving no temporary file', () => {
  const tree = imageTree();

  const result = run(options(tree));

  expect(result).toEqual({ status: 0, stderr: '' });
  expect(readFileSync(tree.target, 'utf8')).toBe(PATCHED);
  expect(sha256(readFileSync(tree.target))).toBe(sha256(PATCHED));
  expect(statSync(tree.target).mode & 0o7777).toBe(0o444);
  expect(statSync(tree.target).uid).toBe(process.getuid());
  expect(readdirSync(join(tree.copy, 'lib'))).toEqual(['index.js']);
});

it('does not count a symbolic link to the real copy', () => {
  const tree = imageTree();
  symlinkSync(tree.copy, join(tree.global, NAME));

  expect(run(options(tree))).toEqual({ status: 0, stderr: '' });
  expect(readFileSync(tree.target, 'utf8')).toBe(PATCHED);
});

it('refuses a different package version', () => {
  const tree = imageTree({ version: '1.0.1' });

  expectRefused(tree, options(tree), 'version');
});

it('refuses when no copy is installed', () => {
  const tree = imageTree(null);

  expectRefused(tree, options(tree), 'copy-count');
});

it.each([
  ['in the global root', (tree) => join(tree.global, NAME)],
  ['in a nested node_modules', (tree) => join(tree.opt, 'other/node_modules', NAME)],
])('refuses a second copy %s', (_where, second) => {
  const tree = imageTree();
  writePackage(second(tree));

  expectRefused(tree, options(tree), 'copy-count');
});

it('refuses when the only copy is a symbolic link', () => {
  const tree = imageTree(null);
  const outside = join(tree.base, 'outside', NAME);
  writePackage(outside);
  symlinkSync(outside, tree.copy);

  expectRefused(tree, options(tree), 'copy-count');
});

it('refuses a single copy outside the expected directory', () => {
  const tree = imageTree(null);
  writePackage(join(tree.opt, 'elsewhere', NAME));

  expectRefused(tree, options(tree), 'location');
});

it('refuses a malformed candidate manifest during discovery', () => {
  const tree = imageTree();
  mkdirSync(join(tree.global, 'broken'));
  writeFileSync(join(tree.global, 'broken/package.json'), `{"name":"${NAME}",`);

  expectRefused(tree, options(tree), 'discovery');
});

it('refuses a copy without the target file', () => {
  const tree = imageTree({ source: null });

  expectRefused(tree, options(tree), 'input-read');
});

it('refuses a different input SHA-256', () => {
  const tree = imageTree({ source: `${SOURCE}// drift\n` });

  expectRefused(tree, options(tree), 'input-sha256');
});

it.each([
  ['zero times', SOURCE.replace('function derive(input) {\n', 'function other(input) {\n')],
  ['twice', `${SOURCE}function derive(input) {\n}\n`],
])('refuses an anchor that occurs %s', (_count, source) => {
  const tree = imageTree({ source });

  expectRefused(
    tree,
    options(tree, { targets: [target({ inputSha256: sha256(source) })] }),
    'anchor',
  );
});

it('refuses a different output SHA-256', () => {
  const tree = imageTree();

  expectRefused(
    tree,
    options(tree, { targets: [target({ outputSha256: sha256(SOURCE) })] }),
    'output-sha256',
  );
});

it('refuses a failed write and removes its partial temporary file', () => {
  const tree = imageTree();
  const write = (descriptor, text) => {
    writeFileSync(descriptor, text.slice(0, 8));
    throw new Error(`${MARK} ${tree.target}`);
  };

  expectRefused(tree, options(tree), 'write', { write });
});

it('never adopts or removes an existing temporary path', () => {
  const tree = imageTree();
  writeFileSync(`${tree.target}.${String(process.pid)}.patch.tmp`, 'not ours');

  expectRefused(tree, options(tree), 'write');
});

it('patches every target with its reviewed output', () => {
  const tree = imageTree({ second: SECOND_SOURCE });

  const result = run(options(tree, { targets: [target(), secondTarget()] }));

  expect(result).toEqual({ status: 0, stderr: '' });
  expect(readFileSync(tree.target, 'utf8')).toBe(PATCHED);
  expect(readFileSync(tree.second, 'utf8')).toBe(SECOND_PATCHED);
  expect(statSync(tree.second).mode & 0o7777).toBe(0o444);
  expect(readdirSync(join(tree.copy, 'lib')).sort()).toEqual(['client.js', 'index.js']);
});

it.each([
  ['input SHA-256', `${SECOND_SOURCE}// drift\n`, {}, 'input-sha256'],
  [
    'anchor',
    SECOND_SOURCE.replace('function derive(input) {\n', 'function other(input) {\n'),
    (second) => ({ inputSha256: sha256(second) }),
    'anchor',
  ],
  ['output SHA-256', SECOND_SOURCE, { outputSha256: sha256(SECOND_SOURCE) }, 'output-sha256'],
])('writes neither target when the second target fails its %s', (_check, second, pin, check) => {
  const tree = imageTree({ second });
  const overrides = typeof pin === 'function' ? pin(second) : pin;

  expectRefused(tree, options(tree, { targets: [target(), secondTarget(overrides)] }), check);
});

/** A write that fails on the listed calls (1-based) and records every text it was given. */
function failingWrite(failing) {
  const texts = [];
  const write = (descriptor, text) => {
    texts.push(text);
    if (failing.includes(texts.length)) throw new Error(`${MARK} write ${String(texts.length)}`);
    writeFileSync(descriptor, text);
  };
  return { texts, write };
}

it('writes the first target back when the second target fails to write', () => {
  const tree = imageTree({ second: SECOND_SOURCE });
  const { texts, write } = failingWrite([2]);

  expectRefused(tree, options(tree, { targets: [target(), secondTarget()] }), 'write', { write });

  expect(texts).toEqual([PATCHED, SECOND_PATCHED, SOURCE]);
});

it('still refuses the write when writing the first target back fails as well', () => {
  const tree = imageTree({ second: SECOND_SOURCE });
  const { texts, write } = failingWrite([2, 3]);

  const result = run(options(tree, { targets: [target(), secondTarget()] }), { write });

  expect(result).toEqual({ status: 1, stderr: 'patch-package: refused: write\n' });
  expect(texts).toEqual([PATCHED, SECOND_PATCHED, SOURCE]);
  expect(readFileSync(tree.target, 'utf8')).toBe(PATCHED);
  expect(readFileSync(tree.second, 'utf8')).toBe(SECOND_SOURCE);
  expect(readdirSync(join(tree.copy, 'lib')).sort()).toEqual(['client.js', 'index.js']);
});

it('applies the onlyoffice table when each original occurs exactly once', () => {
  const pin = PINS.onlyoffice;
  const source = pin.replacements.map(([original]) => `${original}\n// ${MARK}\n`).join('');
  const patched = pin.replacements
    .map(([, replacement]) => `${replacement}\n// ${MARK}\n`)
    .join('');
  const tree = imageTree({ source });

  const result = run(
    options(tree, {
      targets: [target({ inputSha256: sha256(source), outputSha256: sha256(patched) })],
      replacements: pin.replacements,
    }),
  );

  expect(result).toEqual({ status: 0, stderr: '' });
  const text = readFileSync(tree.target, 'utf8');
  expect(text).toContain('process.env.DSH_TEAM_ONLYOFFICE_FILE_SECRET ?? ""');
  expect(text).toContain('createHmac("sha256", FILE_TOKEN_SECRET)');
  expect(text).not.toContain('"dsh-sidebar-onlyoffice/file-token/v1"');
  expect(text).not.toContain('createHash("sha256").update(`${host}');
  // DSH 0.2.1-rc.2 host service: every injected and read webRuntime becomes webStartup.
  expect(text).not.toContain('webRuntime');
  expect(text).toContain('\t"webStartup"\n];');
  expect(text).toContain('const runtime = () => ctx.webStartup;');
  expect(text.split('isTrustedApiRequest(req, plugin.webStartup.trustedHosts)')).toHaveLength(3);
});

it('pins exactly nine distinct onlyoffice replacements for the released lib/index.js', () => {
  const pin = PINS.onlyoffice;

  const originals = pin.replacements.map(([original]) => original);

  expect(pin).toMatchObject({
    package: 'dsh-sidebar-onlyoffice',
    directory: 'dsh-sidebar-onlyoffice',
    version: '0.2.0',
    targets: [
      {
        target: 'lib/index.js',
        inputSha256: 'e2148f01c2740c464eb39eaf6b9547f773a7b1a172039e9554e03da617d4b29b',
        outputSha256: '30c3ffd21bda284e9daa205bd3f71ec08eeb61dfad999080608a9a81d49196ef',
      },
    ],
  });
  expect(pin.targets).toHaveLength(1);
  expect(originals).toHaveLength(9);
  expect(new Set(originals).size).toBe(9);
});

const SIDEBAR_ANCHOR = 'return file !== void 0 && !hostOwnedPath(file.path);';

it('pins one better-sidebar 0.28.0 replacement for both released client bundles', () => {
  const pin = PINS['better-sidebar'];

  const inputs = pin.targets.map(({ target: path, inputSha256 }) => [path, inputSha256]);

  expect(pin).toMatchObject({
    package: 'dsh-better-sidebar',
    directory: 'dsh-better-sidebar',
    version: '0.28.0',
  });
  expect(inputs).toEqual([
    ['lib/client.js', '53b70b1b5317205247c074b8121e1ececec1df2dc3771b0641f0a66b8fd127e1'],
    ['lib/client-registry.js', '9862678d65831b031a72b54e560f5ad3dd94f00403429072a4c0a75c52d0da85'],
  ]);
  for (const { outputSha256 } of pin.targets) expect(outputSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(pin.replacements).toHaveLength(1);
  expect(pin.replacements[0][0]).toBe(SIDEBAR_ANCHOR);
});

const FILE_PREFIX = 'dsh-resource://file';
// The release's rule (native/index.ts hostOwnedPath) over the extensions these cases use.
const HOST_OWNED = new Set(['docx', 'xlsx', 'pptx', 'doc', 'pdf']);

/**
 * The pinned replacement as the body of the released `canOpen`, loaded from an owned module so
 * no release code runs; returns it with the viewer table and the disabled viewer ids it reads.
 */
async function loadCanOpen() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-team-patch-package-can-open-'));
  owned.push(base);
  const body = `const file = parseFileAddress(address);\n${PINS['better-sidebar'].replacements[0][1]}`;
  const module = join(base, 'can-open.mjs');
  writeFileSync(
    module,
    `export const make = (parseFileAddress, hostOwnedPath, service) => (address) => { ${body} };\n`,
  );
  const { make } = await import(pathToFileURL(module).href);
  const parseFileAddress = (address) =>
    address.startsWith(`${FILE_PREFIX}/`) ? { path: address.slice(FILE_PREFIX.length) } : undefined;
  const hostOwnedPath = (path) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 && HOST_OWNED.has(name.slice(dot + 1).toLowerCase());
  };
  const viewers = [];
  const disabled = new Set();
  const service = {
    getFileViewers: () => viewers,
    isViewerEnabled: (id) => !disabled.has(id),
  };
  const canOpen = make(parseFileAddress, hostOwnedPath, service);
  const open = (...names) => names.map((name) => canOpen(`${FILE_PREFIX}/work/${name}`));
  return { open, viewers, disabled };
}

it('leaves docx, xlsx and pptx to DSH while no viewer is registered', async () => {
  const { open } = await loadCanOpen();

  const opened = open('a.docx', 'b.XLSX', 'c.pptx', 'd.doc', 'e.pdf', 'f.md');

  expect(opened).toEqual([false, false, false, false, false, true]);
});

it('takes docx in any case once an enabled viewer declares it, and nothing else of the host set', async () => {
  const { open, viewers } = await loadCanOpen();
  viewers.push(
    { id: 'code', exts: [] },
    { id: 'preview' },
    { id: 'onlyoffice:docx', exts: ['docx'] },
  );

  const opened = open('a.docx', 'b.DOCX', 'c.xlsx', 'd.doc', 'e.pdf', 'f.md');

  expect(opened).toEqual([true, true, false, false, false, true]);
});

it('returns docx to DSH once its declaring viewer is disabled', async () => {
  const { open, viewers, disabled } = await loadCanOpen();
  viewers.push({ id: 'onlyoffice:docx', exts: ['docx'] });
  disabled.add('onlyoffice:docx');

  const opened = open('a.docx', 'd.doc', 'e.pdf', 'f.md');

  expect(opened).toEqual([false, false, false, true]);
});

function runMain(argv, pins) {
  const chunks = [];
  const status = main(argv, (text) => chunks.push(text), pins);
  return { status, stderr: chunks.join('') };
}

it('selects the pin by name and expects its copy directly below the first root', () => {
  const tree = imageTree();
  const pins = {
    synthetic: {
      package: NAME,
      directory: NAME,
      version: '1.0.0',
      targets: [target(), secondTarget()],
      replacements: REPLACEMENTS,
    },
  };
  writeFileSync(tree.second, SECOND_SOURCE, { mode: 0o444 });

  expect(runMain(['synthetic', tree.opt, tree.global], pins)).toEqual({ status: 0, stderr: '' });
  expect(readFileSync(tree.target, 'utf8')).toBe(PATCHED);
  expect(readFileSync(tree.second, 'utf8')).toBe(SECOND_PATCHED);
});

it.each(['onlyoffice', 'better-sidebar'])(
  'refuses the %s pin when its package is not installed',
  (pin) => {
    const tree = imageTree();
    const before = snapshot(tree.base);

    expect(runMain([pin, tree.opt, tree.global])).toEqual({
      status: 1,
      stderr: 'patch-package: refused: copy-count\n',
    });
    expect(snapshot(tree.base)).toEqual(before);
  },
);

it.each([
  ['an unknown name', ['better-sidebarx', '/opt/dsh-team', '/usr/lib'], 'unknown-package'],
  ['an inherited property name', ['constructor', '/opt/dsh-team', '/usr/lib'], 'unknown-package'],
  ['no arguments', [], 'usage'],
  ['a missing global root', ['onlyoffice', '/opt/dsh-team'], 'usage'],
  ['an extra argument', ['onlyoffice', '/opt/dsh-team', '/usr/lib', '/extra'], 'usage'],
])('main refuses %s', (_case, argv, check) => {
  expect(runMain(argv)).toEqual({ status: 1, stderr: `patch-package: refused: ${check}\n` });
});
