/**
 * Test support for catalog-check: a fake image root laid out like the Dockerfile, the repository
 * catalog, and the CLI driven as the build drives it. Every tree is owned by the calling test
 * file and removed by `removeImageTrees` after each test.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { main } from './catalog-check.mjs';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
export const repositoryCatalog = join(repository, 'images/dsh-user/catalog.json');
export const GLOBALS = 'usr/local/lib/node_modules';
export const OPT = 'opt/dsh-team';
export const PROFILE = 'data/home/profiles/web';
export const DSH = `${GLOBALS}/@deepseek-ai/dsh`;
export const RANGE = '>=0.2.1-rc.2 <0.3.0';
export const CATALOG = JSON.parse(readFileSync(repositoryCatalog, 'utf8')).entries;
// Registration records dependencies sorted by package name, not in catalog order.
export const SPECS = Object.fromEntries(
  CATALOG.map((entry) => [entry.package, `file:/opt/dsh-team/${entry.id}`]).sort(([a], [b]) =>
    a < b ? -1 : 1,
  ),
);
export const REGISTERED_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsh-better-sidebar',
  '@dsh-team/knowledge-base',
  '@dsh-team/office-agents',
];
// The manifest DSH initProfile writes, serialized as DSH saves it.
export const INITIAL_MANIFEST = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: REGISTERED_BUNDLES.slice(0, 2) } },
};
export const dshJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
// CommonJS like the real dependency; accepts only the delivered range, and only with prereleases.
const SEMVER_STUB = `exports.satisfies = (version, range, options) =>
  options?.includePrerelease === true && version === '0.2.1-rc.2' && range === ${JSON.stringify(RANGE)};\n`;
export const APP_BOOT = `${DSH}/node_modules/@deepseek-ai/dsh-app-boot`;
// The test owns the marker; the real decision belongs to DSH and is proven by the real build.
export const MARKER = 'dsh-team-test-compatibility';
// ESM like the real dsh-app-boot, so the gate's require(esm) path is exercised. Every call is
// recorded beside the stub; the marker selects accepted (none), a problem object or a throw.
const APP_BOOT_STUB = `import { appendFileSync } from 'node:fs';
export function evaluatePluginCompatibility(manifest, exemptions, installed) {
  appendFileSync(new URL('../calls.jsonl', import.meta.url),
    JSON.stringify({ name: manifest.name, exemptions, installed }) + '\\n');
  const marker = manifest[${JSON.stringify(MARKER)}];
  if (marker === 'throws') throw new Error('malformed peerDependencies\\nsecond line');
  if (marker === 'unmet')
    return { name: manifest.name, version: manifest.version, runtimeVersion: installed,
      requirements: { '@deepseek-ai/dsh-agent': '^0.3.0' }, exempted: false };
  return undefined;
}
`;
// The released fields of the one non-repository entry (npm dsh-better-sidebar@0.28.0).
export const RELEASED_MANIFESTS = {
  'dsh-better-sidebar': {
    name: 'dsh-better-sidebar',
    version: '0.28.0',
    type: 'module',
    peerDependencies: {
      '@deepseek-ai/cordis': '^4.0.5',
      '@deepseek-ai/dsh-agent': '^0.2.1-rc.1',
      react: '^18.2.0',
    },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  },
};

const owned = [];

/** Remove every fake image root created since the last call. */
export function removeImageTrees() {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function write(root, path, value) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}

export function repositoryManifest(plugin) {
  return JSON.parse(readFileSync(join(repository, 'plugins', plugin, 'package.json'), 'utf8'));
}

/** A catalog entry's delivered manifest: the repository plugin's, else the released stub. */
const deliveredManifest = (id) => RELEASED_MANIFESTS[id] ?? repositoryManifest(id);

/** Every evaluator call recorded by the fake DSH's app-boot stub, in call order. */
export function evaluations(tree) {
  const path = join(tree.root, APP_BOOT, 'calls.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * A fake image root laid out like the Dockerfile at the register step (all four plugins under
 * /opt/dsh-team, the initial profile manifest), with its recorded baseline; registered by default,
 * which is the layout at the verify step.
 */
export function imageTree(registered = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-catalog-check-'));
  owned.push(root);
  write(root, `${DSH}/package.json`, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' });
  for (const name of ['dsh-base', 'dsh-web-app'])
    write(root, `${DSH}/node_modules/@deepseek-ai/${name}/package.json`, {
      name: `@deepseek-ai/${name}`,
    });
  write(root, `${APP_BOOT}/package.json`, {
    name: '@deepseek-ai/dsh-app-boot',
    type: 'module',
    exports: { '.': './lib/index.js', './package.json': './package.json' },
  });
  write(root, `${APP_BOOT}/lib/index.js`, APP_BOOT_STUB);
  write(root, `${DSH}/node_modules/semver/package.json`, { name: 'semver', main: 'index.js' });
  write(root, `${DSH}/node_modules/semver/index.js`, SEMVER_STUB);
  for (const name of ['corepack', 'npm', 'pnpm'])
    write(root, `${GLOBALS}/${name}/package.json`, { name });
  const baseline = join(root, OPT, 'npm-baseline.json');
  mkdirSync(join(root, OPT), { recursive: true });
  expect(main(['record', baseline, '--root', root], () => undefined)).toBe(0);
  write(root, `${OPT}/catalog-check.mjs`, '');
  for (const { id } of CATALOG) {
    write(root, `${OPT}/${id}/package.json`, deliveredManifest(id));
    write(root, `${OPT}/${id}/index.js`, `export const id = '${id}';\n`);
    // Delivered files are read-only, like the image's COPY --chmod=0444.
    chmodSync(join(root, OPT, id, 'index.js'), 0o444);
  }
  write(root, `${OPT}/office-agents/skills/official-writing/SKILL.md`, '# 公文写作\n');
  // A third-party entry carries its nested dependency closure, which is never a catalog item.
  write(root, `${OPT}/dsh-better-sidebar/node_modules/@deepseek-ai/schemastery/package.json`, {
    name: '@deepseek-ai/schemastery',
  });
  chmodSync(join(root, OPT, 'office-agents/skills'), 0o700);
  write(root, `${PROFILE}/package.json`, dshJson(INITIAL_MANIFEST));
  const tree = { root, baseline };
  if (registered) expect(register(tree)).toEqual({ status: 0, stderr: '' });
  return tree;
}

export function run(argv) {
  const chunks = [];
  const status = main(argv, (text) => chunks.push(text));
  return { status, stderr: chunks.join('') };
}

export function verify(tree, catalog = repositoryCatalog) {
  return run(['verify', catalog, tree.baseline, '--root', tree.root]);
}

export function register(tree, catalog = repositoryCatalog) {
  return run(['register', catalog, '--root', tree.root]);
}
