// Child-side custody fixture: real journal registration and real observer binding, with the
// resulting daemon objects recorded only in the fixture's private fake-daemon state.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { processBirth } from '../../scripts/probe-browser-native.mjs';
import {
  bindVerificationDockerObserver,
  createVerificationDockerObserverAuthority,
  reserveVerificationDockerObserver,
} from '../../scripts/verification-docker-generations.mjs';
import { registerCleanupTarget } from './docker-cleanup.ts';

const { scenario } = JSON.parse(
  readFileSync(new URL('../../fixture-scenario.json', import.meta.url), 'utf8'),
);
const root = new URL('../../.run/fake-daemon/', import.meta.url);
mkdirSync(root, { recursive: true, mode: 0o700 });
const publish = (path, value) => {
  writeFileSync(`${path}.pending`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.pending`, path);
};
const custody = dirname(process.env.DSH_TEAM_CI_RESOURCE_JOURNAL);
const runId = randomUUID();
const user = randomUUID();
const own = { 'dsh-team.test-run': runId };
const employee = { 'dsh-team.user': user };
const platformId = 'a'.repeat(64);
const employeeId = 'b'.repeat(64);
const startedAt = new Date().toISOString();
const resources = [];
const register = (kind, name, ownership, labels, extra) => {
  registerCleanupTarget([], runId, { kind, name, ownership });
  resources.push({ kind, name, labels, id: name, ...extra });
};
if (scenario !== 'foreign-writer')
  register('container', 'dsh-team-platform', own, own, { id: platformId, platform: true });
register('container', `dsh-team-u-${user}`, employee, employee, { id: employeeId });
register('network', `dsh-team-test-${runId}_default`, own, own, { id: 'd'.repeat(64) });
register('volume', `dsh-team-home-${user}`, employee, employee, {});
if (scenario === 'mismatch')
  register(
    'container',
    `dsh-team-mismatch-${runId}`,
    own,
    { 'dsh-team.test-run': 'foreign-owner' },
    { id: 'e'.repeat(64) },
  );
// Same prefix, never registered: no journal authority exists for it.
resources.push({
  kind: 'container',
  name: `dsh-team-u-sentinel-${runId}`,
  labels: { 'dsh-team.user': 'sentinel' },
  id: 'f'.repeat(64),
});

const imageId = `sha256:${'9'.repeat(64)}`;
const authority = createVerificationDockerObserverAuthority(custody, {
  moduleUrl: 'file:///app/platform/dist/orchestrator/client.js',
  socketPath: '/var/run/docker.sock',
  ...(scenario === 'process-writer' ? {} : { imageId }),
});
const reserved = await reserveVerificationDockerObserver(authority);
if (scenario !== 'unbound') {
  const platform = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./trusted-docker-fake-platform.mjs', import.meta.url)),
      authority.bootstrap,
      authority.authority,
      scenario,
    ],
    // Outside the command group, like a container process: SIGINT cancellation cannot reach it.
    { detached: true, stdio: 'ignore' },
  );
  await once(platform, 'spawn');
  platform.unref();
  const identity = { pid: platform.pid, birth: await processBirth(platform.pid) };
  publish(join(process.env.TMPDIR, 'fake-platform.json'), identity);
  const until = Date.now() + 10_000;
  while (!existsSync(new URL('platform-ready.json', root))) {
    if (Date.now() >= until) throw new Error('Fixture platform did not claim its observer');
    await delay(20);
  }
  bindVerificationDockerObserver(
    reserved,
    scenario === 'process-writer'
      ? { kind: 'process', generation: reserved.generation, ...identity }
      : {
          kind: 'container',
          generation: reserved.generation,
          authority: authority.authority,
          id: scenario === 'foreign-writer' ? employeeId : platformId,
          imageId,
          startedAt,
        },
  );
  for (const resource of resources) if (resource.platform) resource.pid = platform.pid;
}
if (scenario === 'digest')
  process.prependListener('SIGINT', () => {
    const manifest = join(custody, 'manifest.json');
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}\n`);
  });
publish(fileURLToPath(new URL('state.json', root)), { scenario, resources });
