import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { recordBaseline, registerCatalog, verifyCatalog } from './catalog-check.mjs';
import {
  CATALOG,
  DSH,
  dshJson,
  GLOBALS,
  imageTree,
  INITIAL_MANIFEST,
  OPT,
  PROFILE,
  RANGE,
  register,
  RELEASED_MANIFESTS,
  REGISTERED_BUNDLES,
  removeImageTrees,
  repository,
  repositoryCatalog,
  repositoryManifest,
  run,
  SPECS,
  verify,
  write,
} from './catalog-check-fixture.mjs';

afterEach(removeImageTrees);

/** Relative path -> kind, permission bits and bytes of every entry below path. */
function snapshot(path, prefix = '') {
  return Object.fromEntries(
    readdirSync(join(path, prefix))
      .sort()
      .flatMap((name) => {
        const relative = prefix === '' ? name : `${prefix}/${name}`;
        const stat = lstatSync(join(path, relative));
        const mode = stat.mode & 0o777;
        if (!stat.isDirectory())
          return [[relative, { mode, bytes: readFileSync(join(path, relative), 'utf8') }]];
        return [[relative, { mode, directory: true }], ...Object.entries(snapshot(path, relative))];
      }),
  );
}

const withoutModes = (tree) =>
  Object.fromEntries(
    Object.entries(tree).map(([path, entry]) => [path, { ...entry, mode: undefined }]),
  );

function profileManifest(tree) {
  return readFileSync(join(tree.root, PROFILE, 'package.json'), 'utf8');
}

function editProfileManifest(tree, edit) {
  const manifest = JSON.parse(profileManifest(tree));
  edit(manifest);
  write(tree.root, `${PROFILE}/package.json`, dshJson(manifest));
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
  ['a missing register argument', ['register']],
  ['a missing bundle argument', ['bundle']],
  ['an extra bundle argument', ['bundle', 'catalog.json', 'baseline.json']],
  ['an extra register argument', ['register', 'catalog.json', 'baseline.json']],
  ['an extra argument', ['record', 'a.json', 'b.json']],
  ['an unknown option', ['verify', 'catalog.json', 'baseline.json', '--force']],
  ['a root without its value', ['record', 'baseline.json', '--root']],
  ['a repeated root', ['record', 'baseline.json', '--root', '/a', '--root', '/b']],
])('prints one usage line and exits 1 for %s', (_name, argv) => {
  const result = run(argv);

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(
    /^usage: catalog-check\.mjs record .* \| register .* \| verify .*\n$/,
  );
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
      'profile copy differs: @dsh-team/zh-locale',
    ],
  ],
  [
    'an unparseable repository plugin manifest',
    `${OPT}/permission-tiers/package.json`,
    'not json',
    [
      `unparseable package.json: ${OPT}/permission-tiers`,
      'profile copy differs: @dsh-team/permission-tiers',
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
    stderr:
      'catalog entries not preinstalled: @dsh-team/ghost\n' +
      'catalog entries not registered: @dsh-team/ghost\n',
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
      'preinstalled packages not in catalog: @aa/extra, @dsh-team/zh-locale, zz-extra\n' +
      'catalog entries not registered: @dsh-team/ghost-a, @dsh-team/ghost-b\n',
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
  editProfileManifest(tree, (manifest) => {
    manifest.dsh.profile.bundles.push('@dsh-team-test/missing-bundle');
  });

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
    (entries) => entries.push({ ...entries[3], package: '@x/y' }),
    'catalog entry 8 (office-agents) duplicates id office-agents',
  ],
  [
    'a duplicate package',
    (entries) => entries.push({ ...entries[3], id: 'other' }),
    'catalog entry 8 (other) duplicates package @dsh-team/office-agents',
  ],
  [
    'an unknown key',
    (entries) => Object.assign(entries[5], { extra: 1 }),
    'catalog entry 5 (permission-tiers) has unknown key extra',
  ],
  [
    'a missing key',
    (entries) => delete entries[6].category,
    'catalog entry 6 (platform-nav) has invalid category',
  ],
  [
    'a category outside the closed set',
    (entries) => Object.assign(entries[3], { category: 'optional' }),
    'catalog entry 3 (office-agents) has invalid category',
  ],
  [
    'an empty name',
    (entries) => Object.assign(entries[7], { name: ' ' }),
    'catalog entry 7 (zh-locale) has invalid name',
  ],
  [
    'a non-boolean default',
    (entries) => Object.assign(entries[7], { imageDefaultEnabled: 'true' }),
    'catalog entry 7 (zh-locale) has invalid imageDefaultEnabled',
  ],
  [
    'a non-kebab-case id',
    (entries) => Object.assign(entries[6], { id: 'Platform_Nav' }),
    'catalog entry 6 (Platform_Nav) has invalid id',
  ],
  ['a missing id', (entries) => delete entries[6].id, 'catalog entry 6 has invalid id'],
  [
    'an empty package',
    (entries) => Object.assign(entries[3], { package: '' }),
    'catalog entry 3 (office-agents) has invalid package',
  ],
  [
    'a non-object entry',
    (entries) => entries.push('zh-locale'),
    'catalog entry 8 must be an object',
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
      CATALOG.map((entry) => `profile copy differs: ${entry.package}\n`).join(''),
  );
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

it('registers every catalog entry as an installed profile dependency DSH lists', () => {
  const tree = imageTree(false);

  expect(register(tree)).toEqual({ status: 0, stderr: '' });

  const text = profileManifest(tree);
  const manifest = JSON.parse(text);
  expect(text).toBe(
    dshJson({
      ...INITIAL_MANIFEST,
      dependencies: SPECS,
      dsh: { profile: { bundles: REGISTERED_BUNDLES } },
    }),
  );
  expect(Object.keys(manifest.dependencies)).toEqual(Object.keys(SPECS).sort());
  for (const { id, package: name } of CATALOG) {
    const copy = snapshot(join(tree.root, PROFILE, 'node_modules', name));
    expect(withoutModes(copy)).toEqual(withoutModes(snapshot(join(tree.root, OPT, id))));
    for (const entry of Object.values(copy))
      expect(entry.mode).toBe(entry.directory === true ? 0o755 : 0o644);
  }
  expect(statSync(join(tree.root, PROFILE, 'node_modules/@dsh-team/zh-locale')).mode & 0o777).toBe(
    0o755,
  );
  expect(verify(tree)).toEqual({ status: 0, stderr: '' });
});

it('keeps the existing manifest key order and unknown keys, appending after existing bundles', () => {
  const tree = imageTree(false);
  const initial = {
    name: 'dsh-profile-web',
    'x-unknown': { kept: true },
    private: true,
    dependencies: { '@aa/existing': '1.0.0' },
    dsh: { profile: { bundles: [...REGISTERED_BUNDLES.slice(0, 2), '@x/kept'] }, other: 1 },
  };
  write(tree.root, `${PROFILE}/package.json`, dshJson(initial));

  expect(registerCatalog(tree.root, repositoryCatalog)).toEqual({ problems: [] });

  expect(profileManifest(tree)).toBe(
    dshJson({
      ...initial,
      dependencies: { '@aa/existing': '1.0.0', ...SPECS },
      dsh: {
        profile: {
          bundles: [
            ...initial.dsh.profile.bundles,
            'dsh-better-sidebar',
            'dsh-sidebar-onlyoffice',
            '@dsh-team/knowledge-base',
            '@dsh-team/office-agents',
          ],
        },
        other: 1,
      },
    }),
  );
});

it('refuses a second registration without writing anything', () => {
  const tree = imageTree();
  const before = profileManifest(tree);

  expect(register(tree)).toEqual({
    status: 1,
    stderr: CATALOG.map(
      (entry) =>
        `registration target exists: ${PROFILE}/node_modules/${entry.package}\n` +
        `registration target exists: ${entry.package}\n`,
    ).join(''),
  });
  expect(profileManifest(tree)).toBe(before);
});

it.each([
  [
    'an existing dependency key',
    (manifest) => Object.assign(manifest.dependencies, { '@dsh-team/zh-locale': '0.1.0' }),
  ],
  [
    'an existing bundle selection',
    (manifest) => manifest.dsh.profile.bundles.push('@dsh-team/zh-locale'),
  ],
])('refuses %s and copies nothing', (_name, edit) => {
  const tree = imageTree(false);
  editProfileManifest(tree, edit);
  const before = profileManifest(tree);

  expect(register(tree)).toEqual({
    status: 1,
    stderr: 'registration target exists: @dsh-team/zh-locale\n',
  });
  expect(profileManifest(tree)).toBe(before);
  expect(existsSync(join(tree.root, PROFILE, 'node_modules'))).toBe(false);
});

it('requires the canonical /opt/dsh-team source of every entry', () => {
  const tree = imageTree(false);
  rmSync(join(tree.root, OPT, 'platform-nav'), { recursive: true });

  expect(register(tree)).toEqual({
    status: 1,
    stderr: 'registration source missing: platform-nav\n',
  });
  expect(profileManifest(tree)).toBe(dshJson(INITIAL_MANIFEST));
  expect(existsSync(join(tree.root, PROFILE, 'node_modules'))).toBe(false);
});

it.each([
  ['a missing manifest', undefined],
  ['an unparseable manifest', '{'],
  ['a manifest without dependencies', dshJson({ ...INITIAL_MANIFEST, dependencies: undefined })],
  ['a manifest without bundles', dshJson({ ...INITIAL_MANIFEST, dsh: { profile: {} } })],
])('refuses to register into %s', (_name, content) => {
  const tree = imageTree(false);
  const path = join(tree.root, PROFILE, 'package.json');
  if (content === undefined) rmSync(path);
  else writeFileSync(path, content);

  expect(register(tree)).toEqual({
    status: 1,
    stderr: `profile manifest unreadable: ${PROFILE}/package.json\n`,
  });
  expect(existsSync(join(tree.root, PROFILE, 'node_modules'))).toBe(false);
});

it('reports catalog shape problems before registering anything', () => {
  const tree = imageTree(false);
  const catalog = catalogWith(tree, (value) => {
    value.entries[3].category = 'optional';
  });

  expect(register(tree, catalog)).toEqual({
    status: 1,
    stderr: 'catalog entry 3 (office-agents) has invalid category\n',
  });
  expect(profileManifest(tree)).toBe(dshJson(INITIAL_MANIFEST));
});

it('reports a failed copy and leaves the manifest unregistered', () => {
  const tree = imageTree(false);
  symlinkSync(
    join(tree.root, OPT, 'zh-locale/index.js'),
    join(tree.root, OPT, 'zh-locale/link.js'),
  );

  expect(register(tree)).toEqual({ status: 1, stderr: 'registration copy failed: zh-locale\n' });
  expect(profileManifest(tree)).toBe(dshJson(INITIAL_MANIFEST));
});

it('reports a manifest it cannot rewrite', () => {
  const tree = imageTree(false);
  chmodSync(join(tree.root, PROFILE, 'package.json'), 0o444);

  expect(register(tree)).toEqual({
    status: 1,
    stderr: `profile manifest not written: ${PROFILE}/package.json\n`,
  });
  expect(profileManifest(tree)).toBe(dshJson(INITIAL_MANIFEST));
});

it.each([
  ['a missing dependency key', (dependencies) => delete dependencies['@dsh-team/platform-nav']],
  ['an exact version spec', (dependencies) => (dependencies['@dsh-team/platform-nav'] = '0.1.0')],
  [
    'a link: spec',
    (dependencies) => (dependencies['@dsh-team/platform-nav'] = 'link:/opt/dsh-team/platform-nav'),
  ],
])('fails verify for %s', (_name, edit) => {
  const tree = imageTree();
  editProfileManifest(tree, (manifest) => void edit(manifest.dependencies));

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: 'catalog entries not registered: @dsh-team/platform-nav\n',
  });
});

it('fails verify when the profile manifest has no dependencies at all', () => {
  const tree = imageTree();
  editProfileManifest(tree, (manifest) => delete manifest.dependencies);

  expect(verify(tree).stderr).toBe(
    `catalog entries not registered: ${Object.keys(SPECS).sort().join(', ')}\n`,
  );
});

it.each([
  [
    'the manageable bundle is not selected',
    (bundles) => bundles.splice(bundles.indexOf('@dsh-team/office-agents'), 1),
    'catalog default state mismatch: @dsh-team/office-agents expected enabled',
  ],
  [
    'a required plugin is selected',
    (bundles) => bundles.push('@dsh-team/zh-locale'),
    'catalog default state mismatch: @dsh-team/zh-locale expected disabled',
  ],
])('fails verify when %s', (_name, edit, line) => {
  const tree = imageTree();
  editProfileManifest(tree, (manifest) => void edit(manifest.dsh.profile.bundles));

  expect(verify(tree)).toEqual({ status: 1, stderr: `${line}\n` });
});

it.each([
  [
    'a changed byte',
    'node_modules/@dsh-team/zh-locale/index.js',
    "export const id = 'zh-locale!';\n",
  ],
  ['an extra file', 'node_modules/@dsh-team/zh-locale/extra.js', ''],
])('fails verify when the profile copy has %s', (_name, path, content) => {
  const tree = imageTree();
  write(tree.root, `${PROFILE}/${path}`, content);

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: 'profile copy differs: @dsh-team/zh-locale\n',
  });
});

it('fails verify when a copy holds an entry that is neither file nor directory', () => {
  const tree = imageTree();
  const copy = join(tree.root, PROFILE, 'node_modules/@dsh-team/zh-locale');
  symlinkSync(join(copy, 'index.js'), join(copy, 'link.js'));
  symlinkSync(
    join(tree.root, OPT, 'zh-locale/index.js'),
    join(tree.root, OPT, 'zh-locale/link.js'),
  );

  expect(verify(tree).stderr).toBe('profile copy differs: @dsh-team/zh-locale\n');
});

it('declares a bundle patch layer in every repository plugin, empty for the overlay-only ones', () => {
  const plugins = readdirSync(join(repository, 'plugins')).filter((name) =>
    existsSync(join(repository, 'plugins', name, 'package.json')),
  );

  for (const plugin of plugins) {
    const manifest = repositoryManifest(plugin);
    const patch = manifest.dsh?.bundle?.patch;
    expect(typeof patch).toBe('string');
    const path = join(repository, 'plugins', plugin, patch);
    expect(existsSync(path)).toBe(true);
    if (Array.isArray(manifest.files)) expect(manifest.files).toContain(patch.replace(/^\.\//, ''));
  }
  for (const plugin of ['platform-nav', 'permission-tiers', 'office-hints']) {
    const content = readFileSync(join(repository, 'plugins', plugin, 'cordis.patch.yml'), 'utf8');
    const lines = content.split('\n').map((line) => line.replace(/#.*$/, '').trim());
    expect(lines.filter(Boolean)).toEqual(['[]']);
    expect(content.startsWith('#')).toBe(true);
  }
});

const SIDEBAR = 'dsh-better-sidebar';
const ONLYOFFICE = 'dsh-sidebar-onlyoffice';
const manifestPath = (id) => `${OPT}/${id}/package.json`;
const bundle = (tree) => run(['bundle', repositoryCatalog, '--root', tree.root]);

/**
 * Write a released entry's canonical manifest with `dependencies` (and any extra fields) and nest
 * every dependency below it except the `missing` ones; the fixture already nests schemastery.
 */
function releasedWith(tree, id, names, extra = {}, missing = []) {
  const dependencies = Object.fromEntries(names.map((name) => [name, '^1.0.0']));
  const manifest = { ...RELEASED_MANIFESTS[id], dependencies, ...extra };
  write(tree.root, manifestPath(id), manifest);
  for (const name of names.filter((each) => !missing.includes(each)))
    write(tree.root, `${OPT}/${id}/node_modules/${name}/package.json`, { name });
  return manifest;
}

it('bundles the sorted dependency names of every entry with dependencies, keeping mode and leaving the rest byte-identical', () => {
  const tree = imageTree(false);
  const sidebar = releasedWith(tree, SIDEBAR, ['yaml', '@deepseek-ai/schemastery', 'ws']);
  const onlyoffice = releasedWith(tree, ONLYOFFICE, ['@deepseek-ai/schemastery']);
  chmodSync(join(tree.root, manifestPath(SIDEBAR)), 0o444);
  const before = snapshot(join(tree.root, OPT));

  expect(bundle(tree)).toEqual({ status: 0, stderr: '' });

  const after = snapshot(join(tree.root, OPT));
  const changed = [`${SIDEBAR}/package.json`, `${ONLYOFFICE}/package.json`];
  expect(after[changed[0]]).toEqual({
    mode: 0o444,
    bytes: dshJson({
      ...sidebar,
      bundleDependencies: ['@deepseek-ai/schemastery', 'ws', 'yaml'],
    }),
  });
  expect(after[changed[1]]).toEqual({
    mode: before[changed[1]].mode,
    bytes: dshJson({ ...onlyoffice, bundleDependencies: ['@deepseek-ai/schemastery'] }),
  });
  for (const state of [before, after]) for (const path of changed) delete state[path];
  // Every other path, the repository plugins' manifests included: same set, bytes and modes.
  expect(after).toEqual(before);
  expect(register(tree)).toEqual({ status: 0, stderr: '' });
  expect(verify(tree)).toEqual({ status: 0, stderr: '' });
});

it.each([
  [
    'a dependency that is not nested',
    (tree) => releasedWith(tree, ONLYOFFICE, ['@deepseek-ai/schemastery', 'clsx'], {}, ['clsx']),
    `bundle dependency not nested: ${ONLYOFFICE} clsx`,
  ],
  [
    'an existing bundleDependencies field',
    (tree) => releasedWith(tree, ONLYOFFICE, ['clsx'], { bundleDependencies: ['clsx'] }),
    `bundle field exists: ${ONLYOFFICE}`,
  ],
  [
    'an existing bundledDependencies field',
    (tree) => releasedWith(tree, ONLYOFFICE, ['clsx'], { bundledDependencies: true }),
    `bundle field exists: ${ONLYOFFICE}`,
  ],
  [
    'a missing canonical manifest',
    (tree) => rmSync(join(tree.root, manifestPath('platform-nav'))),
    'bundle manifest unreadable: platform-nav',
  ],
])('refuses to bundle with %s and writes no entry', (_name, arrange, problem) => {
  const tree = imageTree(false);
  // A valid entry ahead of the refused one in catalog order: all or nothing.
  releasedWith(tree, SIDEBAR, ['@deepseek-ai/schemastery', 'yaml']);
  arrange(tree);
  const before = snapshot(join(tree.root, OPT));

  expect(bundle(tree)).toEqual({ status: 1, stderr: `${problem}\n` });
  expect(snapshot(join(tree.root, OPT))).toEqual(before);
});

it('reports a manifest it cannot replace and leaves no temporary file', () => {
  const tree = imageTree(false);
  releasedWith(tree, SIDEBAR, ['yaml']);
  const before = snapshot(join(tree.root, OPT));
  chmodSync(join(tree.root, OPT, SIDEBAR), 0o555);

  const result = bundle(tree);
  chmodSync(join(tree.root, OPT, SIDEBAR), 0o755);

  expect(result).toEqual({ status: 1, stderr: `bundle manifest not written: ${SIDEBAR}\n` });
  expect(snapshot(join(tree.root, OPT))).toEqual(before);
});

it.each([
  ['no bundle field', ['yaml'], {}],
  ['an incomplete bundle', ['ws', 'yaml'], { bundleDependencies: ['yaml'] }],
  ['an extra bundled name', ['yaml'], { bundleDependencies: ['ws', 'yaml'] }],
  ['an unsorted bundle', ['ws', 'yaml'], { bundleDependencies: ['yaml', 'ws'] }],
  ['the alias field only', ['yaml'], { bundledDependencies: ['yaml'] }],
])('fails verify when a canonical entry with dependencies has %s', (_name, names, extra) => {
  const tree = imageTree(false);
  // ws is nested in every row, so only the declaration differs.
  write(tree.root, `${OPT}/${SIDEBAR}/node_modules/ws/package.json`, { name: 'ws' });
  releasedWith(tree, SIDEBAR, names, extra);
  expect(register(tree)).toEqual({ status: 0, stderr: '' });

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: `catalog entry dependencies not bundled: ${SIDEBAR}\n`,
  });
});

it('fails verify when a bundled dependency is not nested below the entry', () => {
  const tree = imageTree(false);
  releasedWith(tree, SIDEBAR, ['ws', 'yaml'], { bundleDependencies: ['ws', 'yaml'] }, ['ws']);
  expect(register(tree)).toEqual({ status: 0, stderr: '' });

  expect(verify(tree)).toEqual({
    status: 1,
    stderr: `catalog entry dependencies not bundled: ${SIDEBAR}\n`,
  });
});
