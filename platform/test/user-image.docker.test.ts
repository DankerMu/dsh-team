import { arch, platform } from 'node:os';
import { expect, it } from 'vitest';
import { assertDocxReadback, runUserImage } from './user-image-fixture.ts';
import { profileSeedOracle } from './profile-seed-fixture.ts';
import { execScript } from './managed-policy-fixture.ts';

it('builds the user image and reports exactly DSH 0.2.0-rc.2 with owned-resource cleanup', () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = runUserImage('version', (stdout) => {
    expect(stdout.replace(/\r?\n$/, '')).toBe('0.2.0-rc.2');
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
    const observed: unknown = JSON.parse(summary);
    expect(observed).toMatchObject({ tokenSeen: true, httpStatus: 401, telemetryDisabled: true });
  });

  process.stdout.write(
    `Docker Web startup verified: run=${result.runId} image=${result.image} ` +
      `container=${result.container} state=${String(result.volume)} work=${String(result.workVolume)} ` +
      `readback=${result.stdout} cleanup=complete\n`,
  );
});

it('delivers the platform navigation plugin root-owned, read-only and pinned to the installed DSH', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const script = `
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const require=createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const installed=require('@deepseek-ai/dsh/package.json').version;
assert.equal(manifest.name,'@dsh-team/platform-nav');
assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'],installed);
assert.equal(manifest.exports['./client'],'./client.js');
assert.equal(manifest.dsh.client.platform,'web');
assert.throws(()=>writeFileSync(root+'/client.js','employee code'));
assert.throws(()=>writeFileSync(root+'/employee.js','employee code'));
assert.throws(()=>renameSync(root+'/index.js',root+'/employee.js'));
assert.equal(process.getuid(),1001);
process.stdout.write(JSON.stringify({immutable:true,peer:installed,uid:1001}));
`;

  await runUserImage(
    'managed-policy',
    (stdout) => {
      expect(JSON.parse(stdout)).toEqual({ immutable: true, peer: '0.2.0-rc.2', uid: 1001 });
    },
    undefined,
    (lifecycle) =>
      Promise.resolve(
        execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-platform-nav-trust`, script),
      ),
  );
});

// The reviewed OUTPUT_SHA256 pinned in images/dsh-user/patch-plugin-manager.mjs; the published
// input is bf25686c…, so an unpatched image fails this case.
const PATCHED_PLUGIN_PAGE_SHA256 =
  'ca954298bb89b27f93f49457500a7ef3758e64746a04bded0c83b24ccedf2bdc';

it('installs the plugin page patched, root-owned and unwritable by uid1001, without the patch script', async () => {
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
        sha256: PATCHED_PLUGIN_PAGE_SHA256,
        script: false,
        uid: 1001,
      });
    },
    undefined,
    (lifecycle) =>
      Promise.resolve(
        execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-plugin-page-patch`, script),
      ),
  );
});
