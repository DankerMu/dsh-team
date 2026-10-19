import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createDockerClient, createOrchestrator } from '../src/orchestrator/index.ts';
import { START_CONTAINER, START_USER, startupUnixOwnerFixture } from './container-start-fixture.ts';

const transport = {
  upstreamMode: 'published-loopback',
  platformContainerName: 'dsh-team-platform',
} as const;

async function interrupted(fault: 'response' | 'inspection') {
  const f = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-creation-recovery-wire-',
    users: { [START_USER]: 'employee@example.test' },
    userImage: 'dsh-team-user:local',
    subnetPool: '172.30.0.0/16',
    transport,
  });
  f.replyWith((request, reply) => {
    if (fault === 'response' && request.path === `/containers/create?name=dsh-team-u-${START_USER}`)
      f.dropConnections();
    if (fault === 'inspection' && request.path === `/containers/${START_CONTAINER}/json`)
      return { status: 500 };
    return reply;
  });
  try {
    await expect(f.owner.startUserContainer(f.input)).rejects.toThrow('Container startup failed');
    expect(f.database.prepare('SELECT * FROM instances').all()).toEqual([]);
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(false);
    expect(
      f.daemon.requests.some(({ path }) => path === `/containers/${START_CONTAINER}/start`),
    ).toBe(false);
    f.replyWith(undefined);
    return f;
  } catch (error) {
    await f.close();
    throw error;
  }
}

it.each(['response', 'inspection'] as const)(
  'does not acknowledge no-row retirement after interrupted create %s',
  async (fault) => {
    const f = await interrupted(fault);
    try {
      await f.owner.stopUserContainer({
        userId: START_USER,
        reason: 'admin',
        allowMissingInstance: true,
      });

      expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
      expect(f.database.prepare('SELECT * FROM creation_attempts').all()).toEqual([]);
      expect(f.database.prepare('SELECT status,container_id FROM instances').get()).toEqual({
        status: 'error',
        container_id: null,
      });
    } finally {
      await f.close();
    }
  },
);

it.each(['response', 'inspection'] as const)(
  'reopens durable %s uncertainty and recovers before accepting an explicit replacement',
  async (fault) => {
    const f = await interrupted(fault);
    let reopened: DatabaseHandle | undefined;
    try {
      const mounts = f.daemon.containers.get(START_CONTAINER)?.HostConfig?.Mounts;
      await f.owner.drain();
      f.database.close();
      reopened = openDatabase(join(f.root, 'platform.db'));
      applyMigrations(reopened);
      const owner = createOrchestrator({
        client: createDockerClient(join(f.root, 'engine.sock')),
        database: reopened,
        config: transport,
      });

      await owner.reconcile();

      expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
      expect(reopened.prepare('SELECT * FROM creation_attempts').all()).toEqual([]);
      expect(reopened.prepare('SELECT status,container_id FROM instances').get()).toEqual({
        status: 'error',
        container_id: null,
      });
      expect(
        reopened.prepare('SELECT event_type,target,target_email FROM audit_events').all(),
      ).toEqual([
        {
          event_type: 'instance.start-failed',
          target: START_USER,
          target_email: 'employee@example.test',
        },
      ]);
      const audit = reopened.prepare('SELECT * FROM audit_events').all();
      await owner.reconcile();
      expect(reopened.prepare('SELECT * FROM audit_events').all()).toEqual(audit);
      const replacement = 'd'.repeat(64);
      f.daemon.setContainerId(replacement);
      await expect(owner.startUserContainer(f.input)).resolves.toMatchObject({
        outcome: 'starting',
        containerId: replacement,
      });
      expect(f.daemon.containers.get(replacement)?.HostConfig?.Mounts).toEqual(mounts);
      await owner.drain();
    } finally {
      reopened?.close();
      await f.close();
    }
  },
);
