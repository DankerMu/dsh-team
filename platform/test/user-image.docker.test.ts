import { arch, platform } from 'node:os';
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

it('delivers the platform navigation plugin root-owned, read-only and compatible with the installed DSH', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const script = `
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
${DSH_ENGINES_PRELUDE}
const root='/opt/dsh-team/platform-nav';
assert.deepEqual(readdirSync(root).sort(),['client.js','index.js','package.json']);
const directory=statSync(root);
assert.equal(directory.uid,0); assert.equal(directory.gid,0); assert.equal(directory.mode & 0o777,0o555);
for(const name of ['client.js','index.js','package.json']) {
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
assert.equal(process.getuid(),1001);
process.stdout.write(JSON.stringify({immutable:true,engines:manifest.engines.dsh,uid:1001}));
`;

  await runUserImage(
    'managed-policy',
    (stdout) => {
      expect(JSON.parse(stdout)).toEqual({
        immutable: true,
        engines: '>=0.2.1-rc.2 <0.3.0',
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

  const result = buildUserImageExpectingFailure('platform-nav', '>=0.3.0');

  expect(result.stderr).toContain('DSH plugin compatibility failed: platform-nav');
  process.stdout.write(
    `Docker incompatible plugin rejected: run=${result.runId} image=${result.image} ` +
      `status=${String(result.status)} cleanup=complete\n`,
  );
});
