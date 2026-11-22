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
// A second target of the same package; the pin's replacements apply to every target without its own.
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

// A list of the second target's own, disjoint from the pin's REPLACEMENTS.
const OWN = [['// second\n', '// own\n']];
const ownTarget = (overrides = {}) => ({
  target: SECOND,
  inputSha256: sha256(SECOND_SOURCE),
  outputSha256: sha256(`// own\n${SOURCE}`),
  replacements: OWN,
  ...overrides,
});

it('applies a target its own replacements and the pin replacements to the others only', () => {
  const tree = imageTree({ source: `${SOURCE}// second\n`, second: SECOND_SOURCE });
  const first = target({
    inputSha256: sha256(`${SOURCE}// second\n`),
    outputSha256: sha256(`${PATCHED}// second\n`),
  });

  const result = run(options(tree, { targets: [first, ownTarget()] }));

  expect(result).toEqual({ status: 0, stderr: '' });
  expect(readFileSync(tree.target, 'utf8')).toBe(`${PATCHED}// second\n`);
  expect(readFileSync(tree.second, 'utf8')).toBe(`// own\n${SOURCE}`);
});

it('writes neither target when an anchor of the second target own list is missing', () => {
  const tree = imageTree({ second: SECOND_SOURCE });
  const second = ownTarget({ replacements: [['// absent\n', '// own\n']] });

  expectRefused(tree, options(tree, { targets: [target(), second] }), 'anchor');
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
      {
        target: 'lib/client.js',
        inputSha256: '13df10ce7e4d94ae2951f184c54f69b47d7d7a04f8c50b2f6c201602a7fa0cbc',
        outputSha256: '9a3d7610f576e73688d82939390f650e066f0b017dee21a39cf94236f79c78c0',
      },
    ],
  });
  expect(pin.targets).toHaveLength(2);
  expect(pin.targets[0].replacements).toBeUndefined();
  expect(originals).toHaveLength(9);
  expect(new Set(originals).size).toBe(9);
});

// The released lib/client.js lines the client.js replacements anchor on, at their indentation.
const CLIENT_RUN = [
  '\t\t\t\tconst refreshNow = async () => {',
  '\t\t\t\t\tif (cancelled) return;',
  '\t\t\t\t\trefresh();',
  '\t\t\t\t};',
  '\t\t\t\trefreshRef.current = () => {',
  '\t\t\t\t\trefreshNow();',
  '\t\t\t\t};',
  '\t\t\t\tconst run = async () => {',
  '\t\t\t\t\tconst events = {',
  '\t\t\t\t\t\t\tonDocumentStateChange: (event) => {',
  '\t\t\t\t\t\t\t\tconst dirty = event?.data === true;',
  '\t\t\t\t\t\t\t\tdirtyRef.current = dirty;',
  '\t\t\t\t\t\t\t\tif (!dirty) setStale(null);',
  '\t\t\t\t\t\t\t}',
  '\t\t\t\t\t};',
  '\t\t\t\t\tconst onmessage = (parsed) => {',
  '\t\t\t\t\t\t\tif (parsed.kind === "removed") {',
  '\t\t\t\t\t\t\t\tsetStale({ kind: "removed" });',
  '\t\t\t\t\t\t\t\treturn;',
  '\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\tif (parsed.kind !== "change" || typeof parsed.key !== "string") return;',
  '\t\t\t\t\t\t\tif (parsed.key === currentKeyRef.current) return;',
  '\t\t\t\t\t\t\tif (dirtyRef.current) {',
  '\t\t\t\t\t\t\t\tsetStale({ kind: "changed" });',
  '\t\t\t\t\t\t\t\treturn;',
  '\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\trefreshNow();',
  '\t\t\t\t\t};',
  '\t\t\t\t\texpose(events, onmessage);',
  '\t\t\t\t};',
  '\t\t\t\trun();',
  '',
].join('\n');
// The reviewed result, written out by hand rather than derived by the code under test.
const CLIENT_RUN_PATCHED = CLIENT_RUN.replace(
  '\t\t\t\tconst refreshNow = async () => {\n',
  '\t\t\t\tlet pendingChange = false;\n' +
    '\t\t\t\tconst refreshNow = async () => {\n\t\t\t\t\tpendingChange = false;\n',
)
  .replace(
    '\t\t\t\t\t\t\t\tif (!dirty) setStale(null);\n',
    '\t\t\t\t\t\t\t\tif (!dirty) {\n' +
      '\t\t\t\t\t\t\t\t\tif (pendingChange) refreshNow();\n' +
      '\t\t\t\t\t\t\t\t\telse setStale(null);\n' +
      '\t\t\t\t\t\t\t\t}\n',
  )
  .replace(
    '\t\t\t\t\t\t\tif (dirtyRef.current) {\n',
    '\t\t\t\t\t\t\tif (dirtyRef.current) {\n\t\t\t\t\t\t\t\tpendingChange = true;\n',
  );

it('pins three distinct onlyoffice replacements of its own for the released lib/client.js', () => {
  const [, client] = PINS.onlyoffice.targets;

  const originals = client.replacements.map(([original]) => original);

  expect(originals).toHaveLength(3);
  expect(new Set(originals).size).toBe(3);
  const shared = new Set(PINS.onlyoffice.replacements.map(([original]) => original));
  for (const original of originals) expect(shared.has(original)).toBe(false);
});

/**
 * The released client.js lines patched by the pinned client.js target, loaded from an owned module
 * so no release code runs; returns the editor and watch handlers with what they called.
 */
async function loadClientRun() {
  const tree = imageTree({ second: CLIENT_RUN });
  const [, client] = PINS.onlyoffice.targets;
  const pinned = {
    ...client,
    inputSha256: sha256(CLIENT_RUN),
    outputSha256: sha256(CLIENT_RUN_PATCHED),
  };
  expect(run(options(tree, { targets: [target(), pinned] }))).toEqual({ status: 0, stderr: '' });
  const module = join(tree.base, 'client-run.mjs');
  writeFileSync(
    module,
    'export const make = (dirtyRef, currentKeyRef, refreshRef, setStale, refresh, expose) => {\n' +
      `let cancelled = false;\n${readFileSync(tree.second, 'utf8')}};\n`,
  );
  const { make } = await import(pathToFileURL(module).href);
  const calls = [];
  let handlers;
  const refreshRef = { current: null };
  make(
    { current: false },
    { current: 'opened' },
    refreshRef,
    (stale) => calls.push(stale === null ? 'clear' : stale.kind),
    () => calls.push('refresh'),
    (events, onmessage) => (handlers = { events, onmessage }),
  );
  const dirty = (data) => handlers.events.onDocumentStateChange({ data });
  const watch = (kind, key = 'rewritten') => handlers.onmessage({ kind, key });
  return { calls, dirty, watch, reload: () => refreshRef.current() };
}

it('refreshes once when the editor turns clean after a change arrived while it was dirty', async () => {
  const { calls, dirty, watch } = await loadClientRun();

  dirty(true);
  watch('change');
  watch('change');
  dirty(false);
  dirty(true);
  dirty(false);

  expect(calls).toEqual(['changed', 'changed', 'refresh', 'clear']);
});

it('clears the banner as released when a manual reload already took the pending change', async () => {
  const { calls, dirty, watch, reload } = await loadClientRun();

  dirty(true);
  watch('change');
  reload();
  dirty(false);

  expect(calls).toEqual(['changed', 'refresh', 'clear']);
});

it('keeps the released clean, same-key and removed behaviour', async () => {
  const { calls, dirty, watch } = await loadClientRun();

  watch('change');
  dirty(true);
  watch('change', 'opened');
  watch('removed');
  dirty(false);

  expect(calls).toEqual(['refresh', 'removed', 'clear']);
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
  for (const { replacements } of pin.targets) expect(replacements).toBeUndefined();
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

it('passes a pin target its own replacements', () => {
  const tree = imageTree({ second: SECOND_SOURCE });
  const pins = {
    synthetic: {
      package: NAME,
      directory: NAME,
      version: '1.0.0',
      targets: [target(), ownTarget()],
      replacements: REPLACEMENTS,
    },
  };

  expect(runMain(['synthetic', tree.opt, tree.global], pins)).toEqual({ status: 0, stderr: '' });
  expect(readFileSync(tree.target, 'utf8')).toBe(PATCHED);
  expect(readFileSync(tree.second, 'utf8')).toBe(`// own\n${SOURCE}`);
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
