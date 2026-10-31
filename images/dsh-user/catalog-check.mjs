/**
 * Build-time gate of the user image: the preinstalled items equal images/dsh-user/catalog.json.
 * `record` captures the toolchain+DSH global packages right after their install line; `verify`
 * enumerates what the build added beyond that baseline (globals, /opt/dsh-team plugins, profile
 * node_modules, registered non-DSH bundles), checks each delivered plugin's engines.dsh against the
 * installed DSH and compares the package-name sets in both directions. No dependencies.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Image paths, relative to --root (default /).
const GLOBALS = 'usr/local/lib/node_modules';
const PLUGINS = 'opt/dsh-team';
const PROFILE = 'data/home/profiles/web';
const DSH = `${GLOBALS}/@deepseek-ai/dsh/package.json`;
const ENTRY_KEYS = ['id', 'package', 'name', 'category', 'imageDefaultEnabled'];
/** @type {Record<string, (value: unknown) => boolean>} */
const ENTRY_FIELDS = {
  id: (value) => typeof value === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value),
  package: (value) => typeof value === 'string' && value.trim() !== '',
  name: (value) => typeof value === 'string' && value.trim() !== '',
  category: (value) => value === 'required' || value === 'manageable',
  imageDefaultEnabled: (value) => typeof value === 'boolean',
};
const ARITY = new Map([
  ['record', 1],
  ['verify', 2],
]);
const USAGE =
  'usage: catalog-check.mjs record <baseline.json> [--root <prefix>]' +
  ' | verify <catalog.json> <baseline.json> [--root <prefix>]\n';

/**
 * @typedef {{ name: string, directory: string, manifest: Record<string, any> }} Found
 * @typedef {string[]} Problems
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} path @returns {unknown} undefined when missing or unparseable */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Non-hidden directory names, symlinks judged by their target. @param {string} path */
function directories(path) {
  return readdirSync(path)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(path, name), { throwIfNoEntry: false })?.isDirectory() === true)
    .sort();
}

/**
 * The package in one directory, or undefined when it has no package.json or a problem.
 * @param {string} root @param {string} directory root-relative
 * @param {(name: string) => boolean} accepts @param {Problems} problems
 * @returns {Found | undefined}
 */
function packageAt(root, directory, accepts, problems) {
  const path = join(root, directory, 'package.json');
  if (!existsSync(path)) return undefined;
  const manifest = readJson(path);
  if (!isRecord(manifest)) {
    problems.push(`unparseable package.json: ${directory}`);
    return undefined;
  }
  const { name } = manifest;
  if (typeof name !== 'string' || !accepts(name)) {
    const declared = typeof name === 'string' ? name : 'no name';
    problems.push(`package name mismatch: ${directory} declares ${declared}`);
    return undefined;
  }
  return { name, directory, manifest };
}

/**
 * Top-level and `@scope/*` packages of a node_modules tree; names must equal their path.
 * @param {string} root @param {string} base @param {Problems} problems @returns {Found[]}
 */
function modules(root, base, problems) {
  if (!existsSync(join(root, base))) {
    problems.push(`enumeration root missing: ${base}`);
    return [];
  }
  return directories(join(root, base)).flatMap((entry) => {
    const names = entry.startsWith('@')
      ? directories(join(root, base, entry)).map((child) => `${entry}/${child}`)
      : [entry];
    return names.flatMap(
      (name) => packageAt(root, `${base}/${name}`, (declared) => declared === name, problems) ?? [],
    );
  });
}

/**
 * Repository plugins delivered as /opt/dsh-team/<id>; the name is <id> or @scope/<id>.
 * @param {string} root @param {Problems} problems @returns {Found[]}
 */
function plugins(root, problems) {
  if (!existsSync(join(root, PLUGINS))) {
    problems.push(`enumeration root missing: ${PLUGINS}`);
    return [];
  }
  return directories(join(root, PLUGINS)).flatMap((id) => {
    const accepts = (/** @type {string} */ name) =>
      name === id || /^@[^/]+\/(.+)$/.exec(name)?.[1] === id;
    return packageAt(root, `${PLUGINS}/${id}`, accepts, problems) ?? [];
  });
}

/**
 * The released loader's decision: the installed DSH, DSH's own semver (declared by
 * dsh-app-boot), prereleases included, and no exact DSH peer.
 * @param {string} root @param {Found[]} delivered @param {Problems} problems
 */
function compatibility(root, delivered, problems) {
  const dsh = join(root, DSH);
  let semver;
  let installed;
  try {
    const boot = createRequire(dsh).resolve('@deepseek-ai/dsh-app-boot/package.json');
    semver = createRequire(boot)('semver');
    installed = JSON.parse(readFileSync(dsh, 'utf8')).version;
  } catch {
    problems.push(`DSH semver unavailable: ${DSH}`);
    return;
  }
  for (const plugin of delivered) {
    const range = plugin.manifest.engines?.dsh;
    const peer = plugin.manifest.peerDependencies?.['@deepseek-ai/dsh'];
    if (
      typeof range === 'string' &&
      range.trim() !== '' &&
      peer === undefined &&
      semver.satisfies(installed, range, { includePrerelease: true })
    )
      continue;
    problems.push(
      `DSH plugin compatibility failed: ${basename(plugin.directory)} engines.dsh=${JSON.stringify(range)}` +
        ` peer=${JSON.stringify(peer)} installed=${installed}`,
    );
  }
}

/**
 * Registered bundles DSH resolves from its own package tree are release-shipped; every other
 * one must be preinstalled. Mirrors DSH's lookup without requiring an exported package.json.
 * @param {string} root @param {Set<string>} preinstalled @param {Problems} problems
 */
function registeredBundles(root, preinstalled, problems) {
  const manifest = readJson(join(root, PROFILE, 'package.json'));
  const bundles = isRecord(manifest) ? manifest.dsh?.profile?.bundles : undefined;
  if (!Array.isArray(bundles) || !bundles.every((bundle) => typeof bundle === 'string')) {
    problems.push(`profile bundles unreadable: ${PROFILE}/package.json`);
    return;
  }
  const lookup = createRequire(join(root, DSH)).resolve;
  for (const bundle of bundles) {
    const shipped = (lookup.paths(bundle) ?? []).some((path) =>
      existsSync(join(path, bundle, 'package.json')),
    );
    if (!shipped && !preinstalled.has(bundle))
      problems.push(`registered bundle not preinstalled: ${bundle}`);
  }
}

/**
 * @param {unknown} entry @param {number} index
 * @param {Record<'id' | 'package', Set<string>>} seen @param {Problems} problems
 * @returns {string | undefined} the entry's package name
 */
function catalogEntry(entry, index, seen, problems) {
  if (!isRecord(entry)) {
    problems.push(`catalog entry ${String(index)} must be an object`);
    return undefined;
  }
  const label =
    typeof entry.id === 'string'
      ? `catalog entry ${String(index)} (${entry.id})`
      : `catalog entry ${String(index)}`;
  for (const key of Object.keys(entry))
    if (!ENTRY_KEYS.includes(key)) problems.push(`${label} has unknown key ${key}`);
  for (const key of ENTRY_KEYS)
    if (ENTRY_FIELDS[key]?.(entry[key]) !== true) problems.push(`${label} has invalid ${key}`);
  for (const key of /** @type {const} */ (['id', 'package'])) {
    const value = entry[key];
    if (typeof value !== 'string') continue;
    if (seen[key].has(value)) problems.push(`${label} duplicates ${key} ${value}`);
    seen[key].add(value);
  }
  return typeof entry.package === 'string' ? entry.package : undefined;
}

/** @param {string} path @param {Problems} problems @returns {Set<string> | undefined} */
function catalogPackages(path, problems) {
  const catalog = readJson(path);
  if (!isRecord(catalog)) {
    problems.push(`catalog unreadable: ${path}`);
    return undefined;
  }
  for (const key of Object.keys(catalog))
    if (key !== 'version' && key !== 'entries') problems.push(`catalog has unknown key ${key}`);
  if (catalog.version !== 1) problems.push('catalog version must be 1');
  if (!Array.isArray(catalog.entries)) {
    problems.push('catalog entries must be an array');
    return undefined;
  }
  const seen = { id: new Set(), package: new Set() };
  return new Set(
    catalog.entries.flatMap((entry, index) => catalogEntry(entry, index, seen, problems) ?? []),
  );
}

/** @param {string} path @param {Problems} problems @returns {Set<string> | undefined} */
function baselineGlobals(path, problems) {
  const baseline = readJson(path);
  const globals = isRecord(baseline) ? baseline.globals : undefined;
  if (Array.isArray(globals) && globals.every((name) => typeof name === 'string'))
    return new Set(globals);
  problems.push(`baseline unreadable: ${path}`);
  return undefined;
}

/**
 * Global package names at the toolchain+DSH install step.
 * @param {string} root @returns {{ globals: string[], problems: Problems }}
 */
export function recordBaseline(root) {
  /** @type {Problems} */
  const problems = [];
  const globals = modules(root, GLOBALS, problems).map((found) => found.name);
  return { globals: globals.sort(), problems };
}

/**
 * Every inconsistency between the image under root and the catalog; empty when consistent.
 * @param {string} root @param {string} catalogPath @param {string} baselinePath
 * @returns {{ problems: Problems }}
 */
export function verifyCatalog(root, catalogPath, baselinePath) {
  /** @type {Problems} */
  const problems = [];
  const globals = modules(root, GLOBALS, problems);
  const repository = plugins(root, problems);
  const profile = modules(root, `${PROFILE}/node_modules`, problems);
  const scoped = profile.filter((found) => found.name.startsWith('@'));
  compatibility(root, [...repository, ...scoped], problems);
  const catalog = catalogPackages(catalogPath, problems);
  const baseline = baselineGlobals(baselinePath, problems);
  const delivered = new Set([...globals, ...repository, ...profile].map((found) => found.name));
  if (catalog !== undefined && baseline !== undefined) {
    const preinstalled = new Set(
      [...globals.filter((found) => !baseline.has(found.name)), ...repository, ...profile].map(
        (found) => found.name,
      ),
    );
    const missing = [...catalog].filter((name) => !preinstalled.has(name)).sort();
    const extra = [...preinstalled].filter((name) => !catalog.has(name)).sort();
    if (missing.length !== 0)
      problems.push(`catalog entries not preinstalled: ${missing.join(', ')}`);
    if (extra.length !== 0)
      problems.push(`preinstalled packages not in catalog: ${extra.join(', ')}`);
  }
  registeredBundles(root, delivered, problems);
  return { problems };
}

/**
 * @param {string[]} argv
 * @returns {{ command: string, paths: string[], root: string } | undefined}
 */
function parse(argv) {
  const [command = '', ...rest] = argv;
  const arity = ARITY.get(command);
  if (arity === undefined) return undefined;
  const paths = [];
  let root;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? '';
    if (argument === '--root' && root === undefined && index + 1 < rest.length) {
      index += 1;
      root = rest[index];
    } else if (argument.startsWith('-')) return undefined;
    else paths.push(argument);
  }
  return paths.length === arity ? { command, paths, root: root ?? '/' } : undefined;
}

/**
 * CLI: `record <baseline.json>` or `verify <catalog.json> <baseline.json>`, optional
 * `--root <prefix>` for the image paths. Problems go to stderr, one per line.
 * @param {string[]} argv @param {(text: string) => void} stderr @returns {number} exit status
 */
export function main(argv, stderr) {
  const parsed = parse(argv);
  if (parsed === undefined) {
    stderr(USAGE);
    return 1;
  }
  const [first = '', second = ''] = parsed.paths;
  let problems;
  if (parsed.command === 'record') {
    const baseline = recordBaseline(parsed.root);
    problems = baseline.problems;
    if (problems.length === 0) {
      try {
        // Read-only from creation: the build's umask would otherwise leave it 0644.
        const content = `${JSON.stringify({ globals: baseline.globals }, null, 2)}\n`;
        writeFileSync(first, content, { mode: 0o444, flag: 'wx' });
      } catch {
        problems.push(`baseline not written: ${first}`);
      }
    }
  } else problems = verifyCatalog(parsed.root, first, second).problems;
  stderr(problems.map((problem) => `${problem}\n`).join(''));
  return problems.length === 0 ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2), (text) => process.stderr.write(text));
}
