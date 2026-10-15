import { isDeepStrictEqual } from 'node:util';
import type { PlatformConfig } from '../config.ts';
import type { DatabaseHandle } from '../db/index.ts';
import type { DockerClient } from './client.ts';
import { isTerminalInstance, object, resolvedImageId } from './identity.ts';
import { assertCurrentSnapshot } from './start-identity.ts';
import {
  HomeHelperUnconfirmedError,
  readSeccompPolicy,
  requireAbsent,
  runHomeHelper,
} from './home-helper.ts';
import { readUserHomeVolume } from './volumes.ts';

export interface RestoreUserProfilesInput {
  readonly userId: string;
  readonly config: Pick<PlatformConfig, 'userImage' | 'seccompProfilePath'>;
  readonly signal?: AbortSignal;
}

const RESTORE_PROFILES = `
import { cpSync, rmSync, lstatSync, readdirSync, chmodSync } from 'node:fs';
const seed = '/opt/dsh-team/profile-seed';
const target = '/data/home/profiles';
function walk(path, writable) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('Unsupported profile seed entry');
  if (writable) chmodSync(path, (stat.mode & 0o777) | (stat.isDirectory() ? 0o700 : 0o600));
  if (stat.isDirectory()) for (const name of readdirSync(path)) walk(path + '/' + name, writable);
}
if (!lstatSync(seed + '/web/package.json').isFile()) throw new Error('Missing profile seed');
walk(seed, false);
// rmSync unlinks symlinks, including a replaced top-level profiles entry, without traversal.
rmSync(target, { recursive: true, force: true });
cpSync(seed, target, { recursive: true });
walk(target, true);
`;

function assertRestoreMount(helper: Record<string, unknown>, home: string): void {
  const config = object(helper.Config);
  const host = object(helper.HostConfig);
  const mounts = helper.Mounts;
  if (
    config.User !== '1001' ||
    host.NetworkMode !== 'none' ||
    host.Privileged !== false ||
    (host.CapAdd !== null && (!Array.isArray(host.CapAdd) || host.CapAdd.length !== 0)) ||
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    object(helper.State).Running !== false
  )
    throw new Error('Unsafe profile restoration helper');
  const mount = object(mounts[0]);
  if (
    mount.Type !== 'volume' ||
    mount.Name !== home ||
    mount.Destination !== '/data/home' ||
    mount.RW !== true
  )
    throw new Error('Unexpected profile restoration mount');
}

function restorationFailure(error: unknown): Error {
  return error instanceof HomeHelperUnconfirmedError
    ? error
    : new Error('Profile restoration failed');
}

/** Runs only in the owner's per-user FIFO; never stops, starts, allocates volumes or writes audits. */
export async function restoreUserProfiles(
  input: RestoreUserProfilesInput & {
    readonly client: DockerClient;
    readonly database: DatabaseHandle;
  },
): Promise<void> {
  try {
    const { userId, database, config } = input;
    const deadline = AbortSignal.timeout(60_000);
    const signal =
      input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
    signal.throwIfAborted();
    const account = object(database.prepare('SELECT * FROM users WHERE id = ?').get(userId));
    const instance = object(
      database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userId),
    );
    if (!isTerminalInstance(instance.status, instance.container_id)) throw new Error();
    const client: DockerClient = {
      json: (method, path, body, _signal, maxBytes) =>
        input.client.json(method, path, body, method === 'POST' ? deadline : signal, maxBytes),
      logs: (path) => input.client.logs(path, signal),
    };
    const cleanupClient: DockerClient = {
      ...input.client,
      json: (method, path, body, _signal, maxBytes) =>
        input.client.json(method, path, body, AbortSignal.timeout(10_000), maxBytes),
    };
    const name = `dsh-team-u-${userId}`;
    await requireAbsent(client, name);
    const volume = await readUserHomeVolume(client, userId);
    const imageId = resolvedImageId(
      object(await client.json('GET', `/images/${encodeURIComponent(config.userImage)}/json`)).Id,
    );
    const seccomp = await readSeccompPolicy(config.seccompProfilePath, signal);
    const assertCurrent = () => {
      assertCurrentSnapshot(input, account, instance, signal);
    };
    const beforeStart = async (helper: Record<string, unknown>) => {
      assertRestoreMount(helper, `dsh-team-home-${userId}`);
      await requireAbsent(client, name);
      if (!isDeepStrictEqual(await readUserHomeVolume(client, userId), volume)) throw new Error();
      assertCurrent();
    };
    assertCurrent();
    await runHomeHelper(
      {
        client,
        cleanupClient,
        userId,
        home: `dsh-team-home-${userId}`,
        imageId,
        seccomp,
        role: 'profile-reset',
        beforeStart,
      },
      (run) => run(RESTORE_PROFILES),
    );
    assertCurrent();
  } catch (error) {
    throw restorationFailure(error);
  }
}
