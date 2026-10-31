import {
  existsSync,
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { main, recordBaseline, verifyCatalog } from './catalog-check.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const repositoryCatalog = join(repository, 'images/dsh-user/catalog.json');
const GLOBALS = 'usr/local/lib/node_modules';
const OPT = 'opt/dsh-team';
const PROFILE = 'data/home/profiles/web';
const DSH = `${GLOBALS}/@deepseek-ai/dsh`;
const RANGE = '>=0.2.1-rc.2 <0.3.0';
// CommonJS like the real dependency; accepts only the delivered range, and only with prereleases.
const SEMVER_STUB = `exports.satisfies = (version, range, options) =>
  options?.includePrerelease === true && version === '0.2.1-rc.2' && range === ${JSON.stringify(RANGE)};\n`;

const owned = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root, path, value) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}

function repositoryManifest(plugin) {
  return JSON.parse(readFileSync(join(repository, 'plugins', plugin, 'package.json'), 'utf8'));
}

/** A fake image root laid out like the Dockerfile at the verify step, with its recorded baseline. */
function imageTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-catalog-check-'));
  owned.push(root);
  write(root, `${DSH}/package.json`, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' });
  for (const name of ['dsh-app-boot', 'dsh-base', 'dsh-web-app'])
    write(root, `${DSH}/node_modules/@deepseek-ai/${name}/package.json`, {
      name: `@deepseek-ai/${name}`,
    });
  write(root, `${DSH}/node_modules/semver/package.json`, { name: 'semver', main: 'index.js' });
  write(root, `${DSH}/node_modules/semver/index.js`, SEMVER_STUB);
  for (const name of ['corepack', 'npm', 'pnpm'])
    write(root, `${GLOBALS}/${name}/package.json`, { name });
  const baseline = join(root, OPT, 'npm-baseline.json');
  mkdirSync(join(root, OPT), { recursive: true });
  expect(main(['record', baseline, '--root', root], () => undefined)).toBe(0);
  write(root, `${OPT}/catalog-check.mjs`, '');
  for (const plugin of ['permission-tiers', 'platform-nav'])
    write(root, `${OPT}/${plugin}/package.json`, repositoryManifest(plugin));
  for (const plugin of ['zh-locale', 'office-agents'])
    write(
      root,
      `${PROFILE}/node_modules/@dsh-team/${plugin}/package.json`,
      repositoryManifest(plugin),
    );
  write(root, `${PROFILE}/package.json`, {
    name: 'dsh-profile-web',
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-team/office-agents'],
      },
    },
  });
  return { root, baseline };
}

function run(argv) {
  const chunks = [];
  const status = main(argv, (text) => chunks.push(text));
  return { status, stderr: chunks.join('') };
}

function verify(tree, catalog = repositoryCatalog) {
  return run(['verify', catalog, tree.baseline, '--root', tree.root]);
}

function catalogWith(tree, mutate) {
  const catalog = JSON.parse(readFileSync(repositoryCatalog, 'utf8'));
  const changed = mutate(catalog) ?? catalog;
  const path = join(tree.root, 'catalog.json');
  writeFileSync(path, typeof changed === 'string' ? changed : JSON.stringify(changed));
  return path;
}

it('records the sorted top-level and scoped global package names in a read-only baseline', () => {
  const { root } = imageTree();
  write(root, `${GLOBALS}/@scope/b/package.json`, { name: '@scope/b' });
  write(root, `${GLOBALS}/.hidden/package.json`, { name: '.hidden' });
  write(root, `${GLOBALS}/.package-lock.json`, '{}');
  write(root, `${GLOBALS}/README.md`, 'not a package');
  mkdirSync(join(root, GLOBALS, 'no-manifest'));
  write(root, 'elsewhere/linked/package.json', { name: 'linked' });
  symlinkSync(join(root, 'elsewhere/linked'), join(root, GLOBALS, 'linked'));
  symlinkSync(join(root, GLOBALS, 'README.md'), join(root, GLOBALS, 'file-link'));
  symlinkSync(join(root, 'absent'), join(root, GLOBALS, 'dangling'));
  const path = join(root, 'baseline.json');

  const result = run(['record', path, '--root', root]);

  expect(result).toEqual({ status: 0, stderr: '' });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    globals: ['@deepseek-ai/dsh', '@scope/b', 'corepack', 'linked', 'npm', 'pnpm'],
  });
  expect(statSync(path).mode & 0o777).toBe(0o444);
  expect(recordBaseline(root).problems).toEqual([]);
});

it('records exactly the toolchain and DSH in the fake image baseline', () => {
  const { baseline } = imageTree();

  expect(JSON.parse(readFileSync(baseline, 'utf8'))).toEqual({
    globals: ['@deepseek-ai/dsh', 'corepack', 'npm', 'pnpm'],
  });
});

it('refuses to overwrite an existing baseline', () => {
  const tree = imageTree();

  expect(run(['record', tree.baseline, '--root', tree.root])).toEqual({
    status: 1,
    stderr: `baseline not written: ${tree.baseline}\n`,
  });
});

it.each([
  ['no arguments', []],
  ['an unknown subcommand', ['list', 'baseline.json']],
  ['a missing record argument', ['record']],
  ['a missing verify argument', ['verify', 'catalog.json']],
  ['an extra argument', ['record', 'a.json', 'b.json']],
  ['an unknown option', ['verify', 'catalog.json', 'baseline.json', '--force']],
  ['a root without its value', ['record', 'baseline.json', '--root']],
  ['a repeated root', ['record', 'baseline.json', '--root', '/a', '--root', '/b']],
])('prints one usage line and exits 1 for %s', (_name, argv) => {
  const result = run(argv);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^usage: catalog-check\.mjs record .* verify .*\n$/);
});

it('accepts the consistent image with the repository catalog and writes nothing', () => {
  const tree = imageTree();

  expect(verify(tree)).toEqual({ status: 0, stderr: '' });
  expect(verifyCatalog(tree.root, repositoryCatalog, tree.baseline)).toEqual({ problems: [] });
});

it.each([
  [
    'an unscoped directory declaring another name',
    `${GLOBALS}/foo/package.json`,
    { name: 'bar' },
    `package name mismatch: ${GLOBALS}/foo declares bar`,
  ],
  [
    'a scoped directory declaring an unscoped name',
    `${GLOBALS}/@scope/pkg/package.json`,
    { name: 'pkg' },
    `package name mismatch: ${GLOBALS}/@scope/pkg declares pkg`,
  ],
  [
    'a manifest without a name',
    `${GLOBALS}/nameless/package.json`,
    { version: '1.0.0' },
    `package name mismatch: ${GLOBALS}/nameless declares no name`,
  ],
  [
    'an unparseable manifest',
    `${GLOBALS}/broken/package.json`,
    '{',
    `unparseable package.json: ${GLOBALS}/broken`,
  ],
  [
    'a non-object manifest',
    `${GLOBALS}/array/package.json`,
    '[]',
    `unparseable package.json: ${GLOBALS}/array`,
  ],
])('fails record and writes no baseline for %s', (_name, path, manifest, problem) => {
  const { root } = imageTree();
  write(root, path, manifest);
  const baseline = join(root, 'baseline.json');

  expect(run(['record', baseline, '--root', root])).toEqual({ status: 1, stderr: `${problem}\n` });
  expect(existsSync(baseline)).toBe(false);
});

it.each([
  [
    'a repository plugin declaring another scoped name',
    `${OPT}/platform-nav/package.json`,
    { ...repositoryManifest('platform-nav'), name: '@dsh-team/other' },
    [`package name mismatch: ${OPT}/platform-nav declares @dsh-team/other`],
  ],
  [
    'a profile package declaring another name',
    `${PROFILE}/node_modules/@dsh-team/zh-locale/package.json`,
    { ...repositoryManifest('zh-locale'), name: '@dsh-team/other' },
    [
      `package name mismatch: ${PROFILE}/node_modules/@dsh-team/zh-locale declares @dsh-team/other`,
      'catalog entries not preinstalled: @dsh-team/zh-locale',
    ],
  ],
  [
    'an unparseable repository plugin manifest',
    `${OPT}/permission-tiers/package.json`,
    'not json',
    [
      `unparseable package.json: ${OPT}/permission-tiers`,
      'catalog entries not preinstalled: @dsh-team/permission-tiers',
    ],
  ],
])('fails verify for %s', (_name, path, manifest, problems) => {
  const tree = imageTree();
  write(tree.root, path, manifest);

  expect(verifyCatalog(tree.root, repositoryCatalog, tree.baseline).problems).toEqual(
    expect.arrayContaining(problems),
  );
  expect(verify(tree).status).toBe(1);
});

it('skips repository directories without a manifest and accepts an unscoped plugin name', () => {
  const tree = imageTree();
  mkdirSync(join(tree.root, OPT, 'credentials'));
  write(tree.root, `${OPT}/profile-seed/web/package.json`, { name: 'dsh-profile-web' });
  write(tree.root, `${OPT}/plain/package.json`, {
    name: 'plain',
    engines: { dsh: RANGE },
  });

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: 'preinstalled packages not in catalog: plain\n',
  });
});

it('reports a catalog entry missing from the image', () => {
  const tree = imageTree();
  const catalog = catalogWith(tree, (value) => {
    value.entries.push({
      id: 'ghost',
      package: '@dsh-team/ghost',
      name: '幽灵',
      category: 'manageable',
      imageDefaultEnabled: false,
    });
  });

  expect(verify(tree, catalog)).toEqual({
    status: 1,
    stderr: 'catalog entries not preinstalled: @dsh-team/ghost\n',
  });
});

it('reports a preinstalled plugin missing from the catalog', () => {
  const tree = imageTree();
  const catalog = catalogWith(tree, (value) => {
    value.entries = value.entries.filter((entry) => entry.id !== 'platform-nav');
  });

  expect(verify(tree, catalog)).toEqual({
    status: 1,
    stderr: 'preinstalled packages not in catalog: @dsh-team/platform-nav\n',
  });
});

it('reports an extra global package beyond the baseline', () => {
  const tree = imageTree();
  write(tree.root, `${GLOBALS}/dsh-team-extra/package.json`, {
    name: 'dsh-team-extra',
    version: '0.0.0',
  });

  const result = verify(tree);

  expect(result).toEqual({
    status: 1,
    stderr: 'preinstalled packages not in catalog: dsh-team-extra\n',
  });
  expect(result.stderr).not.toContain('catalog entries not preinstalled');
});

it('reports both directions at once, each sorted', () => {
  const tree = imageTree();
  write(tree.root, `${GLOBALS}/zz-extra/package.json`, { name: 'zz-extra' });
  write(tree.root, `${GLOBALS}/@aa/extra/package.json`, { name: '@aa/extra' });
  const catalog = catalogWith(tree, (value) => {
    value.entries = value.entries.filter((entry) => entry.id !== 'zh-locale');
    for (const id of ['ghost-b', 'ghost-a'])
      value.entries.push({
        id,
        package: `@dsh-team/${id}`,
        name: '幽灵',
        category: 'required',
        imageDefaultEnabled: false,
      });
  });

  expect(verify(tree, catalog)).toEqual({
    status: 1,
    stderr:
      'catalog entries not preinstalled: @dsh-team/ghost-a, @dsh-team/ghost-b\n' +
      'preinstalled packages not in catalog: @aa/extra, @dsh-team/zh-locale, zz-extra\n',
  });
});

it('resolves DSH-shipped registered bundles from the DSH package tree only', () => {
  const tree = imageTree();
  rmSync(join(tree.root, DSH, 'node_modules/@deepseek-ai/dsh-web-app'), { recursive: true });

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: 'registered bundle not preinstalled: @deepseek-ai/dsh-web-app\n',
  });
});

it('reports a registered bundle that is neither DSH-shipped nor preinstalled', () => {
  const tree = imageTree();
  const manifest = JSON.parse(readFileSync(join(tree.root, PROFILE, 'package.json'), 'utf8'));
  manifest.dsh.profile.bundles.push('@dsh-team-test/missing-bundle');
  write(tree.root, `${PROFILE}/package.json`, manifest);

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: 'registered bundle not preinstalled: @dsh-team-test/missing-bundle\n',
  });
});

it.each([
  ['a missing manifest', undefined],
  ['an unparseable manifest', '{'],
  ['a manifest without bundles', { name: 'dsh-profile-web', dsh: { profile: {} } }],
  ['non-string bundles', { name: 'dsh-profile-web', dsh: { profile: { bundles: [1] } } }],
])('fails on a profile with %s', (_name, manifest) => {
  const tree = imageTree();
  const path = join(tree.root, PROFILE, 'package.json');
  if (manifest === undefined) rmSync(path);
  else write(tree.root, `${PROFILE}/package.json`, manifest);

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: `profile bundles unreadable: ${PROFILE}/package.json\n`,
  });
});

it.each([
  [
    'a duplicate id',
    (entries) => entries.push({ ...entries[0], package: '@x/y' }),
    'catalog entry 4 (office-agents) duplicates id office-agents',
  ],
  [
    'a duplicate package',
    (entries) => entries.push({ ...entries[0], id: 'other' }),
    'catalog entry 4 (other) duplicates package @dsh-team/office-agents',
  ],
  [
    'an unknown key',
    (entries) => Object.assign(entries[1], { extra: 1 }),
    'catalog entry 1 (permission-tiers) has unknown key extra',
  ],
  [
    'a missing key',
    (entries) => delete entries[2].category,
    'catalog entry 2 (platform-nav) has invalid category',
  ],
  [
    'a category outside the closed set',
    (entries) => Object.assign(entries[0], { category: 'optional' }),
    'catalog entry 0 (office-agents) has invalid category',
  ],
  [
    'an empty name',
    (entries) => Object.assign(entries[3], { name: ' ' }),
    'catalog entry 3 (zh-locale) has invalid name',
  ],
  [
    'a non-boolean default',
    (entries) => Object.assign(entries[3], { imageDefaultEnabled: 'true' }),
    'catalog entry 3 (zh-locale) has invalid imageDefaultEnabled',
  ],
  [
    'a non-kebab-case id',
    (entries) => Object.assign(entries[2], { id: 'Platform_Nav' }),
    'catalog entry 2 (Platform_Nav) has invalid id',
  ],
  ['a missing id', (entries) => delete entries[2].id, 'catalog entry 2 has invalid id'],
  [
    'an empty package',
    (entries) => Object.assign(entries[0], { package: '' }),
    'catalog entry 0 (office-agents) has invalid package',
  ],
  [
    'a non-object entry',
    (entries) => entries.push('zh-locale'),
    'catalog entry 4 must be an object',
  ],
])('fails the catalog shape for %s and names the entry', (_name, mutate, problem) => {
  const tree = imageTree();
  const catalog = catalogWith(tree, (value) => void mutate(value.entries));

  expect(verifyCatalog(tree.root, catalog, tree.baseline).problems).toContain(problem);
  expect(verify(tree, catalog).status).toBe(1);
});

it.each([
  [
    'an unknown top-level key',
    (value) => ({ ...value, extra: true }),
    'catalog has unknown key extra',
  ],
  ['another version', (value) => ({ ...value, version: 2 }), 'catalog version must be 1'],
  ['non-array entries', (value) => ({ ...value, entries: {} }), 'catalog entries must be an array'],
  ['an unparseable file', () => '{', 'catalog unreadable: '],
  ['a non-object document', () => '[]', 'catalog unreadable: '],
])('fails the catalog document for %s', (_name, mutate, problem) => {
  const tree = imageTree();
  const catalog = catalogWith(tree, mutate);

  const result = verify(tree, catalog);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(problem);
});

it('fails on a missing catalog file', () => {
  const tree = imageTree();
  const catalog = join(tree.root, 'absent.json');

  expect(verify(tree, catalog)).toEqual({ status: 1, stderr: `catalog unreadable: ${catalog}\n` });
});

it.each([
  ['missing', undefined],
  ['unparseable', '{'],
  ['without globals', '{}'],
  ['with non-string globals', '{"globals":[1]}'],
])('fails on a %s baseline instead of assuming an empty one', (_name, content) => {
  const tree = imageTree();
  rmSync(tree.baseline);
  if (content !== undefined) writeFileSync(tree.baseline, content);

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: `baseline unreadable: ${tree.baseline}\n`,
  });
});

it('fails on a missing enumeration root', () => {
  const tree = imageTree();
  rmSync(join(tree.root, PROFILE, 'node_modules'), { recursive: true });

  expect(verify(tree).stderr).toBe(
    `enumeration root missing: ${PROFILE}/node_modules\n` +
      'catalog entries not preinstalled: @dsh-team/office-agents, @dsh-team/zh-locale\n' +
      'registered bundle not preinstalled: @dsh-team/office-agents\n',
  );
});

it.each([
  [
    'an excluding range',
    `${OPT}/platform-nav`,
    { engines: { dsh: '>=0.3.0' } },
    'DSH plugin compatibility failed: platform-nav engines.dsh=">=0.3.0" peer=undefined installed=0.2.1-rc.2',
  ],
  [
    'a missing range',
    `${PROFILE}/node_modules/@dsh-team/office-agents`,
    { engines: {} },
    'DSH plugin compatibility failed: office-agents engines.dsh=undefined peer=undefined installed=0.2.1-rc.2',
  ],
  [
    'a blank range',
    `${OPT}/permission-tiers`,
    { engines: { dsh: ' ' } },
    'DSH plugin compatibility failed: permission-tiers engines.dsh=" " peer=undefined installed=0.2.1-rc.2',
  ],
  [
    'an exact DSH peer',
    `${PROFILE}/node_modules/@dsh-team/zh-locale`,
    { peerDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.2' } },
    'DSH plugin compatibility failed: zh-locale engines.dsh=">=0.2.1-rc.2 <0.3.0" peer="0.2.1-rc.2" installed=0.2.1-rc.2',
  ],
])('fails the DSH compatibility check verbatim for %s', (_name, directory, change, line) => {
  const tree = imageTree();
  const path = join(tree.root, directory, 'package.json');
  write(tree.root, `${directory}/package.json`, {
    ...JSON.parse(readFileSync(path, 'utf8')),
    ...change,
  });

  expect(verify(tree)).toEqual({ status: 1, stderr: `${line}\n` });
});

it('fails when the installed DSH semver cannot be loaded', () => {
  const tree = imageTree();
  write(tree.root, `${DSH}/node_modules/semver/index.js`, "throw new Error('broken');\n");

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: `DSH semver unavailable: ${DSH}/package.json\n`,
  });
});

it('lists every repository plugin in the catalog under its plugins/ directory name', () => {
  const catalog = JSON.parse(readFileSync(repositoryCatalog, 'utf8'));
  const byPackage = new Map(catalog.entries.map((entry) => [entry.package, entry]));
  const plugins = readdirSync(join(repository, 'plugins')).filter((name) =>
    existsSync(join(repository, 'plugins', name, 'package.json')),
  );

  expect(plugins.length).toBeGreaterThan(0);
  for (const plugin of plugins) {
    const entry = byPackage.get(repositoryManifest(plugin).name);
    expect(entry?.id).toBe(plugin);
  }
  expect(catalog.entries.map((entry) => entry.id)).toEqual(
    [...catalog.entries.map((entry) => entry.id)].sort(),
  );
});
