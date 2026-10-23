import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNetworkWithProducer } from './browser-network-fixture.ts';

const owned: { root?: string | undefined } = {};

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function substitutePid(root: string) {
  const pid = Number((await readFile(join(root, 'config', 'docker.pid'), 'utf8')).trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Docker substitute identity invalid');
  return pid;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  const root = owned.root;
  owned.root = undefined;
  if (!root) return;
  // Retire only the substitute this test launched, even when its assertion failed.
  const pid = await substitutePid(root).catch(() => undefined);
  if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
  await rm(root, { recursive: true, force: true });
});

it('joins the fixture producer until the original Docker deadline retires a blocked mutation client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-network-fixture-'));
  owned.root = root;
  const bin = join(root, 'bin');
  const config = join(root, 'config');
  await mkdir(bin, { mode: 0o700 });
  await mkdir(config, { mode: 0o700 });
  // A single-process Docker substitute that never answers: only a deadline can retire it.
  const docker = join(bin, 'docker');
  await writeFile(docker, '#!/bin/sh\necho $$ > "$DOCKER_CONFIG/docker.pid"\nexec sleep 120\n');
  await chmod(docker, 0o700);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`);
  vi.stubEnv('DSH_TEAM_BROWSER_DOCKER_CONFIG', config);
  vi.stubEnv('DSH_TEAM_VERIFICATION_SUBMISSIONS', '');

  expect(() =>
    createNetworkWithProducer(['network', 'create', 'dsh-team-browser-net-fixture']),
  ).toThrow('Fixture network producer did not complete');

  // The mutation client must not outlive the joined producer that owns its deadline.
  expect(alive(await substitutePid(root))).toBe(false);
  // The unchanged 30s browserDocker deadline must elapse; the default 5s would abandon the join.
}, 60_000);
