/**
 * Build-time gate of the user image: the preinstalled items equal images/dsh-user/catalog.json.
 * `record` captures the toolchain+DSH global packages right after their install line; `register`
 * copies each catalog entry's /opt/dsh-team/<id> into the Web profile and records it as an
 * installed dependency (selected when its image default is enabled), the form DSH 0.2.1 lists on
 * its plugin page; `verify` enumerates what the build added beyond that baseline (globals,
 * /opt/dsh-team plugins, profile node_modules, registered non-DSH bundles), checks each delivered
 * plugin's engines.dsh against the installed DSH, compares the package-name sets in both
 * directions and checks every entry's registration. No dependencies.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
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
  ['register', 1],
  ['verify', 2],
]);
const USAGE =
  'usage: catalog-check.mjs record <baseline.json> [--root <prefix>]' +
  ' | register <catalog.json> [--root <prefix>]' +
  ' | verify <catalog.json> <baseline.json> [--root <prefix>]\n';

/**
 * @typedef {{ name: string, directory: string, manifest: Record<string, any> }} Found
 * @typedef {{ id: string, package: string, imageDefaultEnabled: boolean }} Entry
 * @typedef {{ dependencies: Record<string, unknown> | undefined, bundles: string[] }} Profile
 * @typedef {{ path: string, kind: 'directory' | 'file' | 'other' }} TreeEntry
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
  // The /opt plugin and its profile registration share a name; the first one found is checked.
  const checked = new Set();
  for (const plugin of delivered) {
    if (checked.has(plugin.name)) continue;
    checked.add(plugin.name);
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
 * The Web profile manifest, its `dependencies` and `dsh.profile.bundles`.
 * @param {string} root @returns {{ manifest: Record<string, any>, profile: Profile } | undefined}
 */
function profileManifest(root) {
  const manifest = readJson(join(root, PROFILE, 'package.json'));
  const bundles = isRecord(manifest) ? manifest.dsh?.profile?.bundles : undefined;
  if (!Array.isArray(bundles) || !bundles.every((bundle) => typeof bundle === 'string'))
    return undefined;
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : undefined;
  return { manifest, profile: { dependencies, bundles } };
}

/**
 * Registered bundles DSH resolves from its own package tree are release-shipped; every other
 * one must be preinstalled. Mirrors DSH's lookup without requiring an exported package.json.
 * @param {string} root @param {string[]} bundles @param {Set<string>} preinstalled
 * @param {Problems} problems
 */
function registeredBundles(root, bundles, preinstalled, problems) {
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
 * @returns {{ name: string | undefined, valid: Entry | undefined }} the entry's package name, and
 * the entry itself when every field is valid
 */
function catalogEntry(entry, index, seen, problems) {
  if (!isRecord(entry)) {
    problems.push(`catalog entry ${String(index)} must be an object`);
    return { name: undefined, valid: undefined };
  }
  const label =
    typeof entry.id === 'string'
      ? `catalog entry ${String(index)} (${entry.id})`
      : `catalog entry ${String(index)}`;
  for (const key of Object.keys(entry))
    if (!ENTRY_KEYS.includes(key)) problems.push(`${label} has unknown key ${key}`);
  const invalid = ENTRY_KEYS.filter((key) => ENTRY_FIELDS[key]?.(entry[key]) !== true);
  for (const key of invalid) problems.push(`${label} has invalid ${key}`);
  for (const key of /** @type {const} */ (['id', 'package'])) {
    const value = entry[key];
    if (typeof value !== 'string') continue;
    if (seen[key].has(value)) problems.push(`${label} duplicates ${key} ${value}`);
    seen[key].add(value);
  }
  return {
    name: typeof entry.package === 'string' ? entry.package : undefined,
    valid: invalid.length === 0 ? /** @type {Entry} */ (entry) : undefined,
  };
}

/**
 * The catalog's package names and its fully valid entries, in catalog order.
 * @param {string} path @param {Problems} problems
 * @returns {{ packages: Set<string>, entries: Entry[] } | undefined}
 */
function catalogEntries(path, problems) {
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
  const checked = catalog.entries.map((entry, index) => catalogEntry(entry, index, seen, problems));
  return {
    packages: new Set(checked.flatMap(({ name }) => name ?? [])),
    entries: checked.flatMap(({ valid }) => valid ?? []),
  };
}

/** The dependency spec recording one registration: the image's canonical copy, never --root. */
const registeredSpec = (/** @type {string} */ id) => `file:/${PLUGINS}/${id}`;

/**
 * Every entry below a directory, parents before children, by name; undefined when it is not one.
 * @param {string} directory @param {string} [prefix] @returns {TreeEntry[] | undefined}
 */
function tree(directory, prefix = '') {
  if (prefix === '' && statSync(directory, { throwIfNoEntry: false })?.isDirectory() !== true)
    return undefined;
  return readdirSync(join(directory, prefix), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((dirent) => {
      const path = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory())
        return [
          { path, kind: /** @type {const} */ ('directory') },
          ...(tree(directory, path) ?? []),
        ];
      return [{ path, kind: dirent.isFile() ? /** @type {const} */ ('file') : 'other' }];
    });
}

/** Same relative paths, kinds and file bytes; owners and permission bits are not compared. */
function sameTree(/** @type {string} */ first, /** @type {string} */ second) {
  const [left, right] = [tree(first), tree(second)];
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every(({ path, kind }, index) => {
      const other = right[index];
      if (other?.path !== path || other.kind !== kind || kind === 'other') return false;
      return (
        kind === 'directory' ||
        readFileSync(join(first, path)).equals(readFileSync(join(second, path)))
      );
    })
  );
}

/**
 * A plain copy of a directory tree: files 0644, directories 0755, owned by the caller.
 * @param {string} source @param {string} target
 */
function copyTree(source, target) {
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o755);
  for (const { path, kind } of tree(source) ?? []) {
    if (kind === 'other') throw new Error(`not a file or directory: ${path}`);
    if (kind === 'directory') mkdirSync(join(target, path));
    else copyFileSync(join(source, path), join(target, path));
    chmodSync(join(target, path), kind === 'directory' ? 0o755 : 0o644);
  }
}

/**
 * Each entry is registered as image-built: dependency spec, default selection, identical copy.
 * @param {string} root @param {Entry[]} entries @param {Profile} profile @param {Problems} problems
 */
function registration(root, entries, profile, problems) {
  const dependencies = profile.dependencies ?? {};
  const unregistered = entries
    .filter((entry) => dependencies[entry.package] !== registeredSpec(entry.id))
    .map((entry) => entry.package)
    .sort();
  if (unregistered.length !== 0)
    problems.push(`catalog entries not registered: ${unregistered.join(', ')}`);
  for (const entry of entries)
    if (profile.bundles.includes(entry.package) !== entry.imageDefaultEnabled)
      problems.push(
        `catalog default state mismatch: ${entry.package} expected ` +
          (entry.imageDefaultEnabled ? 'enabled' : 'disabled'),
      );
  for (const entry of entries)
    if (
      !sameTree(join(root, PLUGINS, entry.id), join(root, PROFILE, 'node_modules', entry.package))
    )
      problems.push(`profile copy differs: ${entry.package}`);
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
  const catalog = catalogEntries(catalogPath, problems);
  const baseline = baselineGlobals(baselinePath, problems);
  const delivered = new Set([...globals, ...repository, ...profile].map((found) => found.name));
  if (catalog !== undefined && baseline !== undefined) {
    const preinstalled = new Set(
      [...globals.filter((found) => !baseline.has(found.name)), ...repository, ...profile].map(
        (found) => found.name,
      ),
    );
    const missing = [...catalog.packages].filter((name) => !preinstalled.has(name)).sort();
    const extra = [...preinstalled].filter((name) => !catalog.packages.has(name)).sort();
    if (missing.length !== 0)
      problems.push(`catalog entries not preinstalled: ${missing.join(', ')}`);
    if (extra.length !== 0)
      problems.push(`preinstalled packages not in catalog: ${extra.join(', ')}`);
  }
  const read = profileManifest(root);
  if (read === undefined) {
    problems.push(`profile bundles unreadable: ${PROFILE}/package.json`);
    return { problems };
  }
  registeredBundles(root, read.profile.bundles, delivered, problems);
  if (catalog !== undefined) registration(root, catalog.entries, read.profile, problems);
  return { problems };
}

/**
 * A missing canonical source, or a copy, dependency or selection that already exists.
 * @param {string} root @param {Entry[]} entries @param {Profile} profile @param {Problems} problems
 */
function conflicts(root, entries, profile, problems) {
  for (const entry of entries) {
    const target = `${PROFILE}/node_modules/${entry.package}`;
    if (tree(join(root, PLUGINS, entry.id)) === undefined)
      problems.push(`registration source missing: ${entry.id}`);
    if (existsSync(join(root, target))) problems.push(`registration target exists: ${target}`);
    if (
      Object.hasOwn(profile.dependencies ?? {}, entry.package) ||
      profile.bundles.includes(entry.package)
    )
      problems.push(`registration target exists: ${entry.package}`);
  }
}

/** @param {string} root @param {Entry[]} entries @param {Problems} problems */
function copies(root, entries, problems) {
  for (const entry of entries) {
    try {
      copyTree(join(root, PLUGINS, entry.id), join(root, PROFILE, 'node_modules', entry.package));
    } catch {
      // A partial copy is not rolled back: the failing build discards the layer.
      problems.push(`registration copy failed: ${entry.id}`);
    }
  }
}

/**
 * Register every catalog entry in the Web profile under root: copy /opt/dsh-team/<id> to
 * node_modules/<package>, record `file:/opt/dsh-team/<id>` in the existing `dependencies` (sorted)
 * and append the image-default-enabled packages to `dsh.profile.bundles`, in catalog order.
 * The manifest keeps its key order and is serialized like DSH's own saveManifest. Nothing is
 * written when the catalog, the manifest, a source or an existing target is a problem.
 * @param {string} root @param {string} catalogPath @returns {{ problems: Problems }}
 */
export function registerCatalog(root, catalogPath) {
  /** @type {Problems} */
  const problems = [];
  const catalog = catalogEntries(catalogPath, problems);
  const read = profileManifest(root);
  const dependencies = read?.profile.dependencies;
  if (dependencies === undefined)
    problems.push(`profile manifest unreadable: ${PROFILE}/package.json`);
  if (catalog === undefined || read === undefined || dependencies === undefined)
    return { problems };
  if (problems.length === 0) conflicts(root, catalog.entries, read.profile, problems);
  if (problems.length === 0) copies(root, catalog.entries, problems);
  if (problems.length !== 0) return { problems };
  const specs = catalog.entries.map((entry) => [entry.package, registeredSpec(entry.id)]);
  // Same key, sorted names: the position of `dependencies` in the manifest is unchanged.
  read.manifest.dependencies = Object.fromEntries(
    [...Object.entries(dependencies), ...specs].sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  for (const entry of catalog.entries)
    if (entry.imageDefaultEnabled) read.profile.bundles.push(entry.package);
  try {
    const content = `${JSON.stringify(read.manifest, null, 2)}\n`;
    writeFileSync(join(root, PROFILE, 'package.json'), content);
  } catch {
    problems.push(`profile manifest not written: ${PROFILE}/package.json`);
  }
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
 * CLI: `record <baseline.json>`, `register <catalog.json>` or `verify <catalog.json>
 * <baseline.json>`, optional `--root <prefix>` for the image paths. Problems go to stderr, one
 * per line.
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
  } else if (parsed.command === 'register') problems = registerCatalog(parsed.root, first).problems;
  else problems = verifyCatalog(parsed.root, first, second).problems;
  stderr(problems.map((problem) => `${problem}\n`).join(''));
  return problems.length === 0 ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2), (text) => process.stderr.write(text));
}
