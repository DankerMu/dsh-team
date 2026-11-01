import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { writeManagedConfig } from '../src/managed-config/index.ts';
import { instanceAddressLayout } from '../src/orchestrator/index.ts';
import {
  assertDocxReadback,
  buildUserImageExpectingFailure,
  runUserImage,
} from './user-image-fixture.ts';
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
const catalogProbe = `
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const owner = (path) => {
  const stat = statSync(path);
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
};
// Every entry below a directory: owner, permission bits and file digest, by relative path.
const tree = (root, prefix = '') => Object.fromEntries(
  readdirSync(root + prefix, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const path = prefix + '/' + entry.name;
      const facts = owner(root + path);
      if (!entry.isDirectory()) return [[path, { ...facts, sha256: sha256(root + path) }]];
      return [[path, { ...facts, directory: true }], ...Object.entries(tree(root, path))];
    }),
);
const files = {};
for (const name of ['catalog.json', 'catalog-check.mjs', 'npm-baseline.json'])
  files[name] = owner('/opt/dsh-team/' + name);
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const seed = read('/opt/dsh-team/profile-seed/web/package.json');
process.stdout.write(JSON.stringify({
  files,
  catalogSha256: sha256('/opt/dsh-team/catalog.json'),
  baseline: read('/opt/dsh-team/npm-baseline.json'),
  dependencies: seed.dependencies,
  bundles: seed.dsh.profile.bundles,
  // The live profile of this fresh volume is Docker's copy-up of the image profile.
  plugins: Object.fromEntries(read('/opt/dsh-team/catalog.json').entries.map((entry) => [entry.package, {
    canonical: { directory: owner('/opt/dsh-team/' + entry.id), tree: tree('/opt/dsh-team/' + entry.id) },
    profile: tree('/data/home/profiles/web/node_modules/' + entry.package),
  }])),
}));
`;

interface TreeFacts {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly directory?: true;
  readonly sha256?: string;
}

/** Canonical /opt copies are root-owned read-only; profile copies are uid1001's identical files. */
function expectRegisteredCopies(observed: unknown, catalog: { id: string; package: string }[]) {
  const plugins = observed as Record<
    string,
    {
      canonical: { directory: TreeFacts; tree: Record<string, TreeFacts> };
      profile: Record<string, TreeFacts>;
    }
  >;
  expect(Object.keys(plugins)).toEqual(catalog.map((entry) => entry.package));
  for (const { package: name } of catalog) {
    const copies = plugins[name];
    if (copies === undefined) throw new Error(`Missing plugin copies: ${name}`);
    const { canonical, profile } = copies;
    expect(canonical.directory).toEqual({ uid: 0, gid: 0, mode: 0o555 });
    for (const facts of Object.values(canonical.tree))
      expect(facts).toMatchObject({ uid: 0, gid: 0, mode: facts.directory ? 0o555 : 0o444 });
    const content = (tree: Record<string, TreeFacts>) =>
      Object.fromEntries(
        Object.entries(tree).map(([path, facts]) => [path, facts.sha256 ?? 'dir']),
      );
    expect(content(profile)).toEqual(content(canonical.tree));
    for (const facts of Object.values(profile))
      expect(facts).toMatchObject({ uid: 1001, mode: facts.directory ? 0o755 : 0o644 });
  }
}

// The version probe cannot read files, so the catalog delivery of the same build is its own case.
it('delivers the repository catalog, its gate, the toolchain+DSH baseline and every registered plugin copy', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const readOnly = { uid: 0, gid: 0, mode: 0o444 };
  const shipped = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

  await runUserImage(
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
      // and the build still passed its gate. Only the image-default-enabled office bundle follows.
      expect(observed.bundles).toEqual([...shipped, '@dsh-team/office-agents']);
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
    },
    undefined,
    (lifecycle) =>
      Promise.resolve(
        execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-catalog`, catalogProbe),
      ),
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

it('delivers the platform navigation plugin and the empty credential store root-owned, read-only and compatible with the installed DSH', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const script = `
import assert from 'node:assert/strict';
import { opendirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
${DSH_ENGINES_PRELUDE}
const root='/opt/dsh-team/platform-nav';
assert.deepEqual(readdirSync(root).sort(),['client.js','cordis.patch.yml','index.js','package.json']);
const directory=statSync(root);
assert.equal(directory.uid,0); assert.equal(directory.gid,0); assert.equal(directory.mode & 0o777,0o555);
for(const name of ['client.js','cordis.patch.yml','index.js','package.json']) {
  const stat=statSync(root+'/'+name);
  assert.equal(stat.uid,0); assert.equal(stat.gid,0); assert.equal(stat.mode & 0o777,0o444);
}
for(const path of ['/opt','/opt/dsh-team']) {
  const stat=statSync(path); assert.equal(stat.uid,0); assert.equal(stat.mode & 0o022,0);
}
const manifest=JSON.parse(readFileSync(root+'/package.json','utf8'));
assert.equal(manifest.name,'@dsh-team/platform-nav');
assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh'],undefined);
assert.equal(dshEnginesSatisfied(manifest.engines?.dsh),true);
assert.equal(manifest.exports['./client'],'./client.js');
assert.equal(manifest.dsh.client.platform,'web');
assert.throws(()=>writeFileSync(root+'/client.js','employee code'));
assert.throws(()=>writeFileSync(root+'/employee.js','employee code'));
assert.throws(()=>renameSync(root+'/index.js',root+'/employee.js'));
// The managed provider's isolated credential store: traversable and empty, never writable.
const store='/opt/dsh-team/credentials';
const credentials=statSync(store);
assert.equal(credentials.uid,0); assert.equal(credentials.gid,0); assert.equal(credentials.mode & 0o777,0o555);
const listing=opendirSync(store);
const entry=listing.readSync();
listing.closeSync();
assert.throws(()=>writeFileSync(store+'/platform.yaml','employee value'),{code:'EACCES'});
assert.equal(process.getuid(),1001);
process.stdout.write(JSON.stringify({immutable:true,engines:manifest.engines.dsh,credentials:entry?.name??null,uid:1001}));
`;

  await runUserImage(
    'managed-policy',
    (stdout) => {
      expect(JSON.parse(stdout)).toEqual({
        immutable: true,
        engines: '>=0.2.1-rc.2 <0.3.0',
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
