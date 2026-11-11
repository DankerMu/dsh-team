import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { writeManagedConfig } from '../src/managed-config/index.ts';
import { instanceAddressLayout } from '../src/orchestrator/index.ts';
import {
  assertDocxReadback,
  buildUserImageExpectingFailure,
  offlineDocxScript,
  PROBE_PLUGIN,
  PROBE_TARBALL,
  runUserImage,
} from './user-image-fixture.ts';
import { assertOfficeConversion, runOfficeConvert } from './office-convert-fixture.ts';
import { RENAMED_FONT, renamedFontDirectory } from './font-rename-fixture.ts';
import { profileSeedOracle } from './profile-seed-fixture.ts';
import { execScript, lifecycleWebNetwork } from './managed-policy-fixture.ts';
import { runWebRejection } from './web-startup-fixture.ts';
import { DSH_ENGINES_PRELUDE } from './dsh-engines.ts';

it('builds the user image and reports exactly DSH 0.2.1-rc.2 with owned-resource cleanup', () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = runUserImage('version', (stdout) => {
    expect(stdout.replace(/\r?\n$/, '')).toBe('0.2.1-rc.2');
  });

  process.stdout.write(
    `Docker version verified: run=${result.runId} image=${result.image} ` +
      `container=${result.container} version=${result.stdout.replace(/\r?\n$/, '')} cleanup=complete\n`,
  );
});

const repositoryCatalog = readFileSync(
  new URL('../../images/dsh-user/catalog.json', import.meta.url),
);
// Judged inside the container, entry by entry, so the output stays a few KiB whatever the trees
// hold (the bounded command cap is 64 KiB; the sidebar's closure alone is ~14,000 files).
const catalogProbe = `
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const owner = (path) => {
  const stat = lstatSync(path);
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
};
// Every entry below a directory, parents first, by relative path; symlinks are never followed.
const walk = (root, prefix = '') => readdirSync(root + prefix).sort().flatMap((name) => {
  const path = prefix + '/' + name;
  const stat = lstatSync(root + path);
  const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
  const entry = { path, kind, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777, size: stat.isFile() ? stat.size : 0 };
  return kind === 'directory' ? [entry, ...walk(root, path)] : [entry];
});
// Tree digest over sorted paths, kinds and file SHA-256; owner and mode judged per entry.
const summary = (root, uid, gid, directoryMode, fileMode) => {
  const entries = walk(root);
  const lines = entries.map((entry) => entry.path + '\\0' + entry.kind +
    (entry.kind === 'file' ? '\\0' + sha256(readFileSync(root + entry.path)) : ''));
  const violations = entries.filter((entry) => !(
    (entry.kind === 'directory' || entry.kind === 'file') && entry.uid === uid &&
    (gid === undefined || entry.gid === gid) &&
    entry.mode === (entry.kind === 'directory' ? directoryMode : fileMode))).map((entry) => entry.path);
  return {
    digest: sha256(lines.join('\\n')),
    files: entries.filter((entry) => entry.kind === 'file').length,
    symlinks: entries.filter((entry) => entry.kind === 'symlink').length,
    bytes: entries.reduce((total, entry) => total + entry.size, 0),
    violations: violations.length,
    firstViolations: violations.slice(0, 5),
    paths: entries.map((entry) => entry.path),
  };
};
const strip = ({ paths, ...rest }) => rest;
const files = {};
for (const name of ['catalog.json', 'catalog-check.mjs', 'npm-baseline.json'])
  files[name] = owner('/opt/dsh-team/' + name);
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const seed = read('/opt/dsh-team/profile-seed/web/package.json');
const plugins = {};
let sidebar;
for (const entry of read('/opt/dsh-team/catalog.json').entries) {
  const canonical = summary('/opt/dsh-team/' + entry.id, 0, 0, 0o555, 0o444);
  // The live profile of this fresh volume is Docker's copy-up of the image profile.
  const profile = summary('/data/home/profiles/web/node_modules/' + entry.package, 1001, undefined, 0o755, 0o644);
  plugins[entry.package] = { canonical: { directory: owner('/opt/dsh-team/' + entry.id), ...strip(canonical) }, profile: strip(profile) };
  if (entry.id !== 'dsh-better-sidebar') continue;
  const manifest = read('/opt/dsh-team/dsh-better-sidebar/package.json');
  const seedCopy = summary('/opt/dsh-team/profile-seed/web/node_modules/dsh-better-sidebar', 0, 0, 0o555, 0o444);
  // A peer is installed when node_modules/<name> occurs at any depth, judged by path segment.
  const peers = Object.fromEntries(Object.keys(manifest.peerDependencies ?? {}).map((name) => {
    const needle = ['node_modules', ...name.split('/')];
    return [name, canonical.paths.filter((path) => {
      const segments = path.split('/');
      return segments.some((_, index) => needle.every((part, offset) => segments[index + offset] === part));
    }).length];
  }));
  // The released document preview's converter resolves its WASM engine this way (libreoffice-kit).
  const dsh = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
  const kit = createRequire(dsh.resolve('@deepseek-ai/dsh-office-to-pdf/package.json'))
    .resolve('@deepseek-ai/libreoffice-kit/package.json');
  sidebar = {
    name: manifest.name,
    version: manifest.version,
    dependencies: Object.keys(manifest.dependencies ?? {}),
    bundleDependencies: manifest.bundleDependencies,
    peers,
    global: lstatSync('/usr/local/lib/node_modules/dsh-better-sidebar', { throwIfNoEntry: false }) !== undefined,
    wasm: createRequire(kit).resolve('@deepseek-ai/libreoffice-kit-wasm/package.json'),
    seed: { digest: seedCopy.digest, bytes: seedCopy.bytes, violations: seedCopy.violations },
  };
}
process.stdout.write(JSON.stringify({
  files,
  catalogSha256: sha256(readFileSync('/opt/dsh-team/catalog.json')),
  baseline: read('/opt/dsh-team/npm-baseline.json'),
  dependencies: seed.dependencies,
  bundles: seed.dsh.profile.bundles,
  plugins,
  sidebar,
}));
`;

interface TreeSummary {
  readonly digest: string;
  readonly files: number;
  readonly symlinks: number;
  readonly bytes: number;
  readonly violations: number;
  readonly firstViolations: readonly string[];
}

// Hardcoded floors against an empty or truncated tree passing: every repository plugin delivers
// at least four files; the sidebar release with its closure about 13,700.
const FILE_FLOORS: Readonly<Record<string, number>> = { 'dsh-better-sidebar': 13_000 };

/**
 * Canonical /opt copies are root-owned read-only; profile copies are uid1001's identical files.
 * The judgement is per entry inside the container; only digests and counters arrive here.
 */
function expectRegisteredCopies(observed: unknown, catalog: { id: string; package: string }[]) {
  const plugins = observed as Record<
    string,
    { canonical: TreeSummary & { directory: unknown }; profile: TreeSummary }
  >;
  expect(Object.keys(plugins)).toEqual(catalog.map((entry) => entry.package));
  for (const { id, package: name } of catalog) {
    const copies = plugins[name];
    if (copies === undefined) throw new Error(`Missing plugin copies: ${name}`);
    const { canonical, profile } = copies;
    expect(canonical.directory).toEqual({ uid: 0, gid: 0, mode: 0o555 });
    expect([name, canonical.violations, canonical.firstViolations]).toEqual([name, 0, []]);
    expect([name, profile.violations, profile.firstViolations]).toEqual([name, 0, []]);
    expect(canonical.files).toBeGreaterThanOrEqual(FILE_FLOORS[id] ?? 4);
    expect(profile.digest).toBe(canonical.digest);
    expect(profile.bytes).toBe(canonical.bytes);
  }
}

interface SidebarFacts {
  readonly name: string;
  readonly version: string;
  readonly dependencies: readonly string[];
  readonly bundleDependencies: unknown;
  readonly peers: Record<string, number>;
  readonly global: boolean;
  readonly wasm: string;
  readonly seed: { readonly digest: string; readonly bytes: number; readonly violations: number };
}

/**
 * The release with only the reviewed Office handoff patch of its two client bundles (judged by the
 * better-sidebar patch case below) and a manifest that only gains `bundleDependencies`, nested
 * without DSH or React, only at its catalog location.
 */
function expectSidebarRelease(observed: Record<string, unknown>): string {
  const sidebar = observed.sidebar as SidebarFacts;
  const copies = (
    observed.plugins as Record<string, { canonical: TreeSummary; profile: TreeSummary } | undefined>
  )['dsh-better-sidebar'];
  if (copies === undefined) throw new Error('Missing sidebar copies');
  const { canonical, profile } = copies;
  expect([sidebar.name, sidebar.version]).toEqual(['dsh-better-sidebar', '0.28.0']);
  expect(sidebar.dependencies.length).toBeGreaterThan(0);
  expect(sidebar.bundleDependencies).toEqual([...sidebar.dependencies].sort());
  expect(canonical.symlinks).toBe(0);
  expect(Object.keys(sidebar.peers)).toEqual(
    expect.arrayContaining(['@deepseek-ai/cordis', 'react', 'react-dom']),
  );
  for (const count of Object.values(sidebar.peers)) expect(count).toBe(0);
  expect(sidebar.global).toBe(false);
  expect(sidebar.wasm).toMatch(
    /^\/usr\/local\/lib\/node_modules\/@deepseek-ai\/dsh\/node_modules\/(?:.+\/)?@deepseek-ai\/libreoffice-kit-wasm\/package\.json$/,
  );
  expect(sidebar.seed).toEqual({ digest: canonical.digest, bytes: canonical.bytes, violations: 0 });
  return `canonicalBytes=${String(canonical.bytes)} profileBytes=${String(profile.bytes)} seedBytes=${String(sidebar.seed.bytes)}`;
}

// The version probe cannot read files, so the catalog delivery of the same build is its own case.
it('delivers the repository catalog, its gate, the toolchain+DSH baseline and every registered plugin copy', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const readOnly = { uid: 0, gid: 0, mode: 0o444 };
  const shipped = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  let sidebarBytes = '';

  const result = await runUserImage(
    'managed-policy',
    (stdout) => {
      const observed = JSON.parse(stdout) as Record<string, unknown>;
      expect(observed.files).toEqual({
        'catalog.json': readOnly,
        'catalog-check.mjs': readOnly,
        'npm-baseline.json': readOnly,
      });
      expect(observed.catalogSha256).toBe(
        createHash('sha256').update(repositoryCatalog).digest('hex'),
      );
      // The digest-pinned base ships npm and corepack; the install line adds pnpm and DSH.
      expect(observed.baseline).toEqual({
        globals: ['@deepseek-ai/dsh', 'corepack', 'npm', 'pnpm'],
      });
      // Positive control: release-shipped bundles are registered, absent from the catalog,
      // and the build still passed its gate. Only the image-default-enabled bundles follow, in
      // catalog order.
      expect(observed.bundles).toEqual([
        ...shipped,
        'dsh-better-sidebar',
        'dsh-sidebar-onlyoffice',
        '@dsh-team/knowledge-base',
        '@dsh-team/office-agents',
      ]);
      const catalog = JSON.parse(repositoryCatalog.toString('utf8')) as {
        entries: { id: string; package: string }[];
      };
      const packages = catalog.entries.map((entry) => entry.package);
      for (const bundle of shipped) expect(packages).not.toContain(bundle);
      // Every catalog entry is an installed dependency DSH lists on its plugin page.
      expect(observed.dependencies).toEqual(
        Object.fromEntries(
          catalog.entries.map((entry) => [entry.package, `file:/opt/dsh-team/${entry.id}`]),
        ),
      );
      expectRegisteredCopies(observed.plugins, catalog.entries);
      sidebarBytes = expectSidebarRelease(observed);
    },
    undefined,
    (lifecycle) =>
      Promise.resolve(
        execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-catalog`, catalogProbe),
      ),
  );

  // Image-size evidence: each of the three sidebar copies adds its bytes to the image or volume.
  process.stdout.write(
    `Docker catalog delivery verified: run=${result.runId} image=${result.image} ` +
      `dsh-better-sidebar ${sidebarBytes} cleanup=complete\n`,
  );
});

it('saves and reopens exact Chinese DOCX content offline as the normal uid1001 user', () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = runUserImage('offline-docx', assertDocxReadback);

  process.stdout.write(
    `Docker offline DOCX verified: run=${result.runId} image=${result.image} ` +
      `container=${result.container} network=none configuredUser=dsh ` +
      `readback=${result.stdout.replace(/\r?\n$/, '')} cleanup=complete\n`,
  );
});

// Red without fonts (#553 VPS report `preview=failed code=gateway/internal`; #554 diagnosis:
// `render` rejects `unavailable`, "No usable fonts were found").
it('converts DOC, PPT and DOCX to Chinese PDFs offline under instance limits with the released preview engine', () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  let evidence = '';

  const result = runUserImage('office-convert', (stdout) => {
    evidence = assertOfficeConversion(stdout, assertDocxReadback);
  });

  process.stdout.write(
    `Docker office conversion verified: run=${result.runId} image=${result.image} ` +
      `container=${result.container} network=none user=1001 memory=4g pids=512 cpus=2 ` +
      `${evidence} cleanup=complete\n`,
  );
});

// With the instance fonts bind (#561): the engine must read the renamed family from that path.
it('renders a Latin DOCX in the family of a bound instance fonts directory with the released preview engine', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  let evidence = '';
  let container = '';

  const result = await runUserImage(
    'container-start',
    (stdout) => {
      evidence = assertOfficeConversion(stdout, assertDocxReadback, RENAMED_FONT);
    },
    undefined,
    (lifecycle) => {
      const fonts = renamedFontDirectory(lifecycle, dirname(lifecycle.overlayDirectory));
      container = `dsh-team-test-${lifecycle.runId}-office-fonts`;
      lifecycle.registerContainer(container);
      const { imageId, runId } = lifecycle;
      const run = { container, imageId, runId, docxScript: offlineDocxScript, fonts };
      return Promise.resolve(runOfficeConvert(lifecycle.command, run));
    },
  );

  process.stdout.write(
    `Docker office instance fonts verified: run=${result.runId} image=${result.image} ` +
      `container=${container} network=none user=1001 fonts=${RENAMED_FONT.family} ` +
      `${evidence} cleanup=complete\n`,
  );
});

it('copies meaningful immutable Web profiles into a fresh named volume and preserves uid1001 edits on reuse', () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = runUserImage('profile-seed', profileSeedOracle());

  process.stdout.write(
    `Docker profile seed verified: run=${result.runId} image=${result.image} ` +
      `containers=${result.containers.join(',')} volume=${String(result.volume)} ` +
      `network=none configuredUser=dsh readback=${result.stdout.replace(/\r?\n$/, '')} cleanup=complete\n`,
  );
});

it('starts real DSH Web under shipped seccomp with separate volumes and unauthenticated HTTP401', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = await runUserImage('web-startup', (summary) => {
    const observed = JSON.parse(summary) as Record<string, unknown>;
    expect(observed).toMatchObject({ tokenSeen: true, httpStatus: 401, telemetryDisabled: true });
    // The fixed-address overlay: the released launch line names the owned /28's base+2.
    expect(observed.announcedHost).toBe(instanceAddressLayout(String(observed.subnet)).container);
  });

  process.stdout.write(
    `Docker Web startup verified: run=${result.runId} image=${result.image} ` +
      `container=${result.container} state=${String(result.volume)} work=${String(result.workVolume)} ` +
      `readback=${result.stdout} cleanup=complete\n`,
  );
});

it('refuses to start DSH Web on a wildcard overlay: nonzero exit within 60s and no launch URL', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = await runUserImage(
    'managed-policy',
    (summary) => {
      expect(JSON.parse(summary)).toMatchObject({ exited: true, launchLine: false });
    },
    undefined,
    async (lifecycle) => {
      const network = lifecycleWebNetwork(lifecycle, 'wildcard');
      const overlay = await writeManagedConfig(
        lifecycle.overlayDirectory,
        'wildcardhost',
        '- id: webserver\n  config:\n    host: 0.0.0.0\n    port: 3080\n',
      );
      const container = `dsh-team-test-${lifecycle.runId}-wildcard`;
      lifecycle.registerContainer(container);
      return runWebRejection(lifecycle.command, {
        container,
        imageId: lifecycle.imageId,
        runId: lifecycle.runId,
        stateVolume: lifecycle.stateVolume,
        workVolume: lifecycle.workVolume,
        overlay,
        seccomp: lifecycle.seccomp,
        network,
      });
    },
  );

  process.stdout.write(
    `Docker wildcard Web overlay refused: run=${result.runId} image=${result.image} ` +
      `readback=${result.stdout} cleanup=complete\n`,
  );
});

it('delivers the platform navigation, knowledge-base and Office hints plugins and the empty credential store root-owned, read-only and compatible with the installed DSH', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const script = `
import assert from 'node:assert/strict';
import { opendirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
${DSH_ENGINES_PRELUDE}
const engines={};
for(const id of ['platform-nav','knowledge-base','office-hints']) {
  const root='/opt/dsh-team/'+id;
  assert.deepEqual(readdirSync(root).sort(),['client.js','cordis.patch.yml','index.js','package.json']);
  const directory=statSync(root);
  assert.equal(directory.uid,0); assert.equal(directory.gid,0); assert.equal(directory.mode & 0o777,0o555);
  for(const name of ['client.js','cordis.patch.yml','index.js','package.json']) {
    const stat=statSync(root+'/'+name);
    assert.equal(stat.uid,0); assert.equal(stat.gid,0); assert.equal(stat.mode & 0o777,0o444);
  }
  const manifest=JSON.parse(readFileSync(root+'/package.json','utf8'));
  assert.equal(manifest.name,'@dsh-team/'+id);
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh'],undefined);
  assert.equal(dshEnginesSatisfied(manifest.engines?.dsh),true);
  assert.equal(manifest.exports['./client'],'./client.js');
  assert.equal(manifest.dsh.client.platform,'web');
  assert.throws(()=>writeFileSync(root+'/client.js','employee code'));
  assert.throws(()=>writeFileSync(root+'/employee.js','employee code'));
  assert.throws(()=>renameSync(root+'/index.js',root+'/employee.js'));
  engines[id]=manifest.engines.dsh;
}
for(const path of ['/opt','/opt/dsh-team']) {
  const stat=statSync(path); assert.equal(stat.uid,0); assert.equal(stat.mode & 0o022,0);
}
// The managed provider's isolated credential store: traversable and empty, never writable.
const store='/opt/dsh-team/credentials';
const credentials=statSync(store);
assert.equal(credentials.uid,0); assert.equal(credentials.gid,0); assert.equal(credentials.mode & 0o777,0o555);
const listing=opendirSync(store);
const entry=listing.readSync();
listing.closeSync();
assert.throws(()=>writeFileSync(store+'/platform.yaml','employee value'),{code:'EACCES'});
assert.equal(process.getuid(),1001);
process.stdout.write(JSON.stringify({immutable:true,engines,credentials:entry?.name??null,uid:1001}));
`;

  await runUserImage(
    'managed-policy',
    (stdout) => {
      expect(JSON.parse(stdout)).toEqual({
        immutable: true,
        engines: {
          'platform-nav': '>=0.2.1-rc.2 <0.3.0',
          'knowledge-base': '>=0.2.1-rc.2 <0.3.0',
          'office-hints': '>=0.2.1-rc.2 <0.3.0',
        },
        credentials: null,
        uid: 1001,
      });
    },
    undefined,
    (lifecycle) =>
      Promise.resolve(
        execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-platform-nav-trust`, script),
      ),
  );
});

// dsh-sidebar-onlyoffice@0.2.0: the reviewed build-time patch of lib/index.js (published
// e2148f01…b29b) and the unpatched published lib/client.js; its manifest only gains
// `bundleDependencies`.
const ONLYOFFICE_PATCHED_INDEX_SHA256 =
  '30c3ffd21bda284e9daa205bd3f71ec08eeb61dfad999080608a9a81d49196ef';
const ONLYOFFICE_RELEASED_CLIENT_SHA256 =
  '13df10ce7e4d94ae2951f184c54f69b47d7d7a04f8c50b2f6c201602a7fa0cbc';

it('delivers dsh-sidebar-onlyoffice 0.2.0 with only the file-token code patch and bundleDependencies, root-owned and unwritable by uid1001, without the patch script', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const script = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
const root='/opt/dsh-team/dsh-sidebar-onlyoffice';
const manifest=JSON.parse(readFileSync(root+'/package.json','utf8'));
const sha=(path)=>createHash('sha256').update(readFileSync(path)).digest('hex');
for(const path of [root,root+'/lib']) {
  const stat=statSync(path); assert.equal(stat.uid,0); assert.equal(stat.gid,0); assert.equal(stat.mode & 0o777,0o555);
}
const target=root+'/lib/index.js';
const stat=statSync(target);
assert.equal(stat.uid,0); assert.equal(stat.gid,0); assert.equal(stat.mode & 0o777,0o444);
assert.throws(()=>writeFileSync(target,'employee code',{flag:'a'}),{code:'EACCES'});
assert.throws(()=>renameSync(target,root+'/lib/employee.js'),{code:'EACCES'});
assert.throws(()=>writeFileSync(root+'/lib/employee.js','employee code'),{code:'EACCES'});
assert.equal(process.getuid(),1001);
process.stdout.write(JSON.stringify({
  version:manifest.version,
  dependencies:Object.keys(manifest.dependencies??{}),
  bundleDependencies:manifest.bundleDependencies,
  index:sha(target),
  profileIndex:sha('/data/home/profiles/web/node_modules/dsh-sidebar-onlyoffice/lib/index.js'),
  seedIndex:sha('/opt/dsh-team/profile-seed/web/node_modules/dsh-sidebar-onlyoffice/lib/index.js'),
  client:sha(root+'/lib/client.js'),
  global:lstatSync('/usr/local/lib/node_modules/dsh-sidebar-onlyoffice',{throwIfNoEntry:false})!==undefined,
  script:existsSync('/tmp/patch-package.mjs') || readdirSync('/opt/dsh-team').includes('patch-package.mjs'),
  uid:1001,
}));
`;

  await runUserImage(
    'managed-policy',
    (stdout) => {
      const { dependencies, bundleDependencies, ...observed } = JSON.parse(stdout) as {
        dependencies: string[];
        bundleDependencies: unknown;
      };
      expect(dependencies.length).toBeGreaterThan(0);
      expect(bundleDependencies).toEqual([...dependencies].sort());
      expect(observed).toEqual({
        version: '0.2.0',
        index: ONLYOFFICE_PATCHED_INDEX_SHA256,
        profileIndex: ONLYOFFICE_PATCHED_INDEX_SHA256,
        seedIndex: ONLYOFFICE_PATCHED_INDEX_SHA256,
        client: ONLYOFFICE_RELEASED_CLIENT_SHA256,
        global: false,
        script: false,
        uid: 1001,
      });
    },
    undefined,
    (lifecycle) =>
      Promise.resolve(execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-onlyoffice`, script)),
  );
});

// dsh-better-sidebar@0.28.0: the reviewed build-time patch of lib/client.js (published
// 53b70b1b…27e1) and lib/client-registry.js (published 9862678d…da85).
const SIDEBAR_PATCHED_CLIENT_SHA256 =
  'dbe401917803729e1d89a6e8cf504c5f0ce46e07a41b424967293317a3e1aeb6';
const SIDEBAR_PATCHED_REGISTRY_SHA256 =
  'ac9d9a748b775336747c03c734b1902432eace04efd0f96a01c7f18444559700';

it('delivers dsh-better-sidebar 0.28.0 with the Office handoff patch in its canonical, profile and seed copies, root-owned and unwritable by uid1001, without the patch script', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const script = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
const root='/opt/dsh-team/dsh-better-sidebar';
const sha=(path)=>createHash('sha256').update(readFileSync(path)).digest('hex');
for(const path of [root,root+'/lib']) {
  const stat=statSync(path); assert.equal(stat.uid,0); assert.equal(stat.gid,0); assert.equal(stat.mode & 0o777,0o555);
}
const copies={};
for(const file of ['client.js','client-registry.js']) {
  const target=root+'/lib/'+file;
  const stat=statSync(target);
  assert.equal(stat.uid,0); assert.equal(stat.gid,0); assert.equal(stat.mode & 0o777,0o444);
  assert.throws(()=>writeFileSync(target,'employee code',{flag:'a'}),{code:'EACCES'});
  assert.throws(()=>renameSync(target,root+'/lib/employee.js'),{code:'EACCES'});
  copies[file]={
    canonical:sha(target),
    profile:sha('/data/home/profiles/web/node_modules/dsh-better-sidebar/lib/'+file),
    seed:sha('/opt/dsh-team/profile-seed/web/node_modules/dsh-better-sidebar/lib/'+file),
  };
}
assert.throws(()=>writeFileSync(root+'/lib/employee.js','employee code'),{code:'EACCES'});
assert.equal(process.getuid(),1001);
process.stdout.write(JSON.stringify({
  version:JSON.parse(readFileSync(root+'/package.json','utf8')).version,
  copies,
  script:existsSync('/tmp/patch-package.mjs') || readdirSync('/opt/dsh-team').includes('patch-package.mjs'),
  uid:1001,
}));
`;
  const client = SIDEBAR_PATCHED_CLIENT_SHA256;
  const registry = SIDEBAR_PATCHED_REGISTRY_SHA256;

  await runUserImage(
    'managed-policy',
    (stdout) => {
      expect(JSON.parse(stdout)).toEqual({
        version: '0.28.0',
        copies: {
          'client.js': { canonical: client, profile: client, seed: client },
          'client-registry.js': { canonical: registry, profile: registry, seed: registry },
        },
        script: false,
        uid: 1001,
      });
    },
    undefined,
    (lifecycle) =>
      Promise.resolve(
        execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-better-sidebar-patch`, script),
      ),
  );
});

interface PluginStep {
  readonly name: string;
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: string;
  readonly timedOut: boolean;
  readonly requests: readonly string[];
  readonly tail: string;
}

interface ProfileState {
  readonly sidebar: { readonly version: string; readonly directory: boolean };
  readonly nested: Record<string, { readonly canonical: number; readonly profile: number }>;
  readonly top: readonly string[];
  readonly dependencies: readonly string[];
  readonly hoisted: readonly string[];
  readonly dump: { readonly status: number | null; readonly diagnostics: readonly string[] };
}

interface OfflinePluginObservation {
  readonly uid: number;
  readonly bundled: readonly string[];
  readonly nestedNames: readonly string[];
  readonly steps: readonly PluginStep[];
  readonly state?: ProfileState;
  readonly stripped?: readonly {
    readonly id: string;
    readonly uid: number;
    readonly modeBefore: number;
    readonly modeAfter: number;
  }[];
  readonly failure?: string;
  readonly oldVolume?: { readonly step: PluginStep; readonly state?: ProfileState };
}

const BUNDLED_ENTRIES = ['dsh-better-sidebar', 'dsh-sidebar-onlyoffice'];
const METADATA_REQUEST = `GET /${PROBE_PLUGIN}`;
const TARBALL_REQUEST = `GET ${PROBE_TARBALL}`;
// The probe plugin's metadata (the preflight and pnpm) and tarball, and pnpm's own version check.
const STAND_IN_REQUESTS = [
  METADATA_REQUEST,
  TARBALL_REQUEST,
  'GET /pnpm',
  // The add preflight's `pnpm view` runs npm, whose own version check fetches the npm packument.
  'GET /npm',
];

/** The nested package names a request path names as segments, raw, `%2F`-encoded or decoded. */
function namedPackages(request: string, names: readonly string[]): string[] {
  const raw = `${request.replace(/^\S+ /, '').replace(/[?#].*$/, '')}/`;
  const forms = [raw, raw.toLowerCase(), decodeURIComponent(raw)];
  return names.filter((name) =>
    [name, name.replace('/', '%2f')].some((form) =>
      forms.some((path) => path.includes(`/${form}/`)),
    ),
  );
}

/** One step exited 0 within its bound and asked the stand-in for nothing a preinstalled item needs. */
function expectStep(step: PluginStep | undefined, name: string): void {
  expect([step?.name, step?.status, step?.signal, step?.error, step?.timedOut], step?.tail).toEqual(
    [name, 0, null, undefined, false],
  );
  for (const request of step?.requests ?? []) expect(STAND_IN_REQUESTS).toContain(request);
}

/** The preinstalled items stay as delivered: nothing re-resolved, hoisted or skipped by DSH. */
function expectProfile(state: ProfileState | undefined, registered: readonly string[]): void {
  if (state === undefined) throw new Error('Missing profile state');
  expect(state.sidebar).toEqual({ version: '0.28.0', directory: true });
  expect(Object.keys(state.nested)).toEqual(BUNDLED_ENTRIES);
  for (const [id, { canonical, profile }] of Object.entries(state.nested)) {
    expect([id, profile]).toEqual([id, canonical]);
    expect(canonical).toBeGreaterThan(0);
  }
  expect(state.top).toEqual(registered);
  expect(state.dependencies).toEqual(registered);
  expect(state.hoisted).toEqual([]);
  expect(state.dump).toEqual({ status: 0, diagnostics: [] });
}

it('installs, uninstalls and repairs an employee plugin offline from a registry holding only that plugin, without resolving any preinstalled dependency', () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const catalog = JSON.parse(repositoryCatalog.toString('utf8')) as {
    entries: { package: string }[];
  };
  const packages = catalog.entries.map((entry) => entry.package).sort();
  let evidence = '';

  const result = runUserImage('offline-plugin', (stdout) => {
    const observed = JSON.parse(stdout) as OfflinePluginObservation;
    expect(observed.failure).toBeUndefined();
    expect(observed.uid).toBe(1001);
    expect(observed.bundled).toEqual(BUNDLED_ENTRIES);
    expect(observed.nestedNames).toEqual(
      expect.arrayContaining(['@deepseek-ai/schemastery', 'yaml']),
    );
    // The invariant itself: no request names any package of the canonical nested closures.
    const requests = [...observed.steps, observed.oldVolume?.step].flatMap(
      (step) => step?.requests ?? [],
    );
    expect(requests.flatMap((request) => namedPackages(request, observed.nestedNames))).toEqual([]);
    const [add, remove, install, extra] = observed.steps;
    expectStep(add, 'add');
    expect(add?.requests).toEqual(expect.arrayContaining([METADATA_REQUEST, TARBALL_REQUEST]));
    expectStep(remove, 'remove');
    expectStep(install, 'install');
    expect(extra).toBeUndefined();
    expectProfile(observed.state, packages);
    // A home volume seeded by an older image: profile copies without the field.
    expect(observed.stripped?.map((copy) => copy.id)).toEqual(BUNDLED_ENTRIES);
    for (const copy of observed.stripped ?? []) {
      // pnpm's re-copy of the 0444 canonical file, or an older image's 0644 register copy.
      expect([0o444, 0o644]).toContain(copy.modeBefore);
      expect([copy.id, copy.uid, copy.modeAfter]).toEqual([copy.id, 1001, 0o644]);
    }
    expectStep(observed.oldVolume?.step, 'add');
    expect(observed.oldVolume?.step.requests).toContain(METADATA_REQUEST);
    expectProfile(observed.oldVolume?.state, [...packages, PROBE_PLUGIN].sort());
    const counts = [...observed.steps, observed.oldVolume?.step].map(
      (step) => `${String(step?.name)}=${String(step?.requests.length)}`,
    );
    evidence = `requests ${counts.join(' ')} nested=${JSON.stringify(observed.state?.nested)}`;
  });

  process.stdout.write(
    `Docker offline plugin operations verified: run=${result.runId} image=${result.image} ` +
      `container=${result.container} network=none user=1001 ${evidence} cleanup=complete\n`,
  );
});

// SHA-256 of the published 0.2.1-rc.2 lib/client.js (npm tarball); any build-time change fails here.
const RELEASED_PLUGIN_PAGE_SHA256 =
  'b4efaa441258a547a0d7b3cab559fe073c69e69fe2bbb617c710ded134e7c4f9';

it('installs the released plugin page unpatched, root-owned and unwritable by uid1001, without the removed patch script', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const script = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const root='/usr/local/lib/node_modules';
const copies=[];
const walk=(dir)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
  if(!entry.isDirectory())continue;
  const path=join(dir,entry.name);
  if(entry.name==='dsh-client-ui-plugin-manager'&&basename(dir)==='@deepseek-ai'&&existsSync(path+'/package.json'))copies.push(path);
  walk(path);
}};
walk(root);
assert.equal(copies.length,1);
const lib=copies[0]+'/lib';
const target=lib+'/client.js';
const stat=statSync(target);
assert.equal(stat.uid,0); assert.equal(stat.gid,0); assert.equal(stat.mode & 0o022,0);
assert.equal(statSync(lib).uid,0); assert.equal(statSync(lib).mode & 0o022,0);
assert.throws(()=>writeFileSync(target,'employee code',{flag:'a'}),{code:'EACCES'});
assert.throws(()=>renameSync(target,lib+'/employee.js'),{code:'EACCES'});
assert.equal(process.getuid(),1001);
process.stdout.write(JSON.stringify({
  sha256:createHash('sha256').update(readFileSync(target)).digest('hex'),
  script:existsSync('/tmp/patch-plugin-manager.mjs'),
  uid:1001,
}));
`;

  await runUserImage(
    'managed-policy',
    (stdout) => {
      expect(JSON.parse(stdout)).toEqual({
        sha256: RELEASED_PLUGIN_PAGE_SHA256,
        script: false,
        uid: 1001,
      });
    },
    undefined,
    (lifecycle) =>
      Promise.resolve(
        execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-plugin-page`, script),
      ),
  );
});

it('fails the user-image build when a plugin engines.dsh range excludes the installed DSH', () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = buildUserImageExpectingFailure({ plugin: 'platform-nav', enginesDsh: '>=0.3.0' });

  expect(result.stderr).toContain('DSH plugin compatibility failed: platform-nav');
  process.stdout.write(
    `Docker incompatible plugin rejected: run=${result.runId} image=${result.image} ` +
      `status=${String(result.status)} cleanup=complete\n`,
  );
});

/** Insert one Dockerfile line before the single catalog verify step of a primary-context copy. */
function beforeVerify(directory: string, line: string): void {
  const path = join(directory, 'Dockerfile');
  const verify = 'RUN node /opt/dsh-team/catalog-check.mjs verify ';
  const original = readFileSync(path, 'utf8');
  if (original.split(verify).length !== 2)
    throw new Error('Dockerfile copy must contain exactly one catalog verify step');
  writeFileSync(path, original.replace(verify, `${line}\n${verify}`));
}

it.each([
  [
    'the catalog omits a preinstalled plugin',
    (directory: string) => {
      const path = join(directory, 'catalog.json');
      const catalog = JSON.parse(readFileSync(path, 'utf8')) as { entries: { id: string }[] };
      const entries = catalog.entries.filter((entry) => entry.id !== 'platform-nav');
      writeFileSync(path, `${JSON.stringify({ ...catalog, entries }, null, 2)}\n`);
    },
    'preinstalled packages not in catalog: @dsh-team/platform-nav',
  ],
  [
    'a global package is installed outside the catalog',
    (directory: string) => {
      beforeVerify(
        directory,
        'RUN mkdir -p /usr/local/lib/node_modules/dsh-team-extra && ' +
          `printf '{"name":"dsh-team-extra","version":"0.0.0"}' > /usr/local/lib/node_modules/dsh-team-extra/package.json`,
      );
    },
    'preinstalled packages not in catalog: dsh-team-extra',
  ],
  [
    'a catalog entry is not registered in the profile',
    (directory: string) => {
      // After register, before verify: drop one installed dependency from the profile manifest.
      beforeVerify(
        directory,
        `RUN node -e 'const fs = require("node:fs"); const path = "/data/home/profiles/web/package.json"; ` +
          `const manifest = JSON.parse(fs.readFileSync(path, "utf8")); ` +
          `delete manifest.dependencies["@dsh-team/platform-nav"]; ` +
          `fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\\n");'`,
      );
    },
    'catalog entries not registered: @dsh-team/platform-nav',
  ],
  [
    'the installed sidebar release is not the expected version',
    (directory: string) => {
      // Only the expected literal changes; the install pin still installs 0.28.0.
      const path = join(directory, 'Dockerfile');
      const literal = 'expected="0.28.0"';
      const original = readFileSync(path, 'utf8');
      if (original.split(literal).length !== 2)
        throw new Error('Dockerfile copy must contain exactly one sidebar version literal');
      writeFileSync(path, original.replace(literal, 'expected="0.28.1"'));
    },
    'dsh-better-sidebar version mismatch: installed=0.28.0 expected=0.28.1',
  ],
  [
    'the preview fonts are not installed',
    (directory: string) => {
      // Only the apt line loses fonts-noto-cjk; the font gate must name its missing face.
      const path = join(directory, 'Dockerfile');
      const packages = ' fonts-noto-cjk fonts-dejavu-core ';
      const original = readFileSync(path, 'utf8');
      if (original.split(packages).length !== 2)
        throw new Error('Dockerfile copy must install the preview fonts exactly once');
      writeFileSync(path, original.replace(packages, ' fonts-dejavu-core '));
    },
    'preview fonts missing: /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  ],
])('fails the user-image build when %s', (_name, primary, expected) => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = buildUserImageExpectingFailure({ primary, expect: expected });

  expect(result.stderr).toContain(expected);
  process.stdout.write(
    `Docker inconsistent catalog rejected: run=${result.runId} image=${result.image} ` +
      `status=${String(result.status)} cleanup=complete\n`,
  );
});
