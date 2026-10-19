import { rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createOrchestrator } from './index.ts';
import type { DockerClient, StopUserContainerInput } from './index.ts';
import {
  START_CONTAINER,
  START_NETWORK,
  START_USER,
  startupOwnerFixture,
} from '../../test/container-start-fixture.ts';

const fixtures: Awaited<ReturnType<typeof startupOwnerFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.owner.drain();
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

async function interrupted(kind: 'response' | 'inspection' = 'inspection') {
  const f = await startupOwnerFixture();
  fixtures.push(f);
  let failing = true;
  const client: DockerClient = {
    ...f.client,
    async json(method, path, body, signal, maxBytes) {
      const result = await f.client.json(method, path, body, signal, maxBytes);
      if (
        failing &&
        ((kind === 'response' && path === `/containers/create?name=dsh-team-u-${START_USER}`) ||
          (kind === 'inspection' && path === `/containers/${START_CONTAINER}/json`))
      )
        throw new Error('Fixture loses the applied operation response');
      return result;
    },
  };
  const fresh = () =>
    createOrchestrator({
      client,
      database: f.database,
      config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
    });
  const owner = fresh();
  await expect(owner.startUserContainer(f.input)).rejects.toThrow('Container startup failed');
  failing = false;
  const attempt = () => f.database.prepare('SELECT * FROM creation_attempts').get();
  const candidate = f.daemon.containers.get(START_CONTAINER);
  if (candidate === undefined) throw new Error('Expected Engine-side created container');
  return { ...f, owner, fresh, attempt, candidate };
}

it.each(['response', 'inspection'] as const)(
  'recovers durable %s loss under a fresh owner and reuses the original volumes',
  async (kind) => {
    const f = await interrupted(kind);
    const before = f.database.prepare('SELECT container_id FROM creation_attempts').get();
    expect(before).toEqual({ container_id: kind === 'response' ? null : START_CONTAINER });
    expect(JSON.stringify(f.attempt())).not.toContain(f.input.modelKey);

    await f.fresh().reconcile();

    expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
    expect(f.attempt()).toBeUndefined();
    expect(
      f.database.prepare('SELECT status,container_id,dsh_cookie FROM instances').get(),
    ).toEqual({ status: 'error', container_id: null, dsh_cookie: null });
    expect(f.database.prepare('SELECT event_type FROM audit_events').all()).toEqual([
      { event_type: 'instance.start-failed' },
    ]);
    const replacement = 'd'.repeat(64);
    f.daemon.setContainerId(replacement);
    await expect(f.owner.startUserContainer(f.input)).resolves.toMatchObject({
      outcome: 'starting',
      containerId: replacement,
    });
    const recreated = f.daemon.containers.get(replacement);
    expect(recreated?.HostConfig?.Mounts).toEqual(f.candidate.HostConfig?.Mounts);
    expect(f.attempt()).toBeUndefined();
    expect(
      f.daemon.requests.some(
        ({ method, path }) => method === 'DELETE' && path.startsWith('/volumes/'),
      ),
    ).toBe(false);
  },
);

it.each([
  'nonce',
  'image',
  'id',
  'running',
  'started',
  'state',
  'mount',
  'publication',
  'network',
  'account',
  'row',
] as const)(
  'quarantines changed %s without deleting the candidate or forgetting provenance',
  async (kind) => {
    const f = await interrupted();
    if (kind === 'nonce')
      f.candidate.Config.Labels = {
        'dsh-team.user': START_USER,
        'dsh-team.creation-attempt': 'foreign',
      };
    if (kind === 'image') f.candidate.Image = `sha256:${'f'.repeat(64)}`;
    if (kind === 'id') f.candidate.Id = 'f'.repeat(64);
    if (kind === 'running') f.candidate.State.Running = true;
    if (kind === 'started') f.candidate.State.StartedAt = '2026-10-01T00:00:00Z';
    if (kind === 'state') f.candidate.State.Status = 'exited';
    if (kind === 'mount' && f.candidate.HostConfig !== undefined)
      f.candidate.HostConfig.Mounts = [];
    if (kind === 'publication' && f.candidate.HostConfig !== undefined)
      f.candidate.HostConfig.PortBindings = { '3080/tcp': [{ HostIp: '0.0.0.0', HostPort: '' }] };
    if (kind === 'network' && f.candidate.HostConfig !== undefined)
      f.candidate.HostConfig.NetworkMode = 'f'.repeat(64);
    if (kind === 'account')
      f.database.prepare('UPDATE users SET created_at=2 WHERE id=?').run(START_USER);
    if (kind === 'row')
      f.database
        .prepare("INSERT INTO instances(user_id,status) VALUES (?, 'stopped')")
        .run(START_USER);
    const retained = f.attempt();
    const count = f.daemon.requests.length;

    await expect(f.fresh().reconcile()).rejects.toThrow('Instance reconciliation failed');
    await expect(
      f.owner.stopUserContainer({
        userId: START_USER,
        reason: 'admin',
        allowMissingInstance: true,
      }),
    ).rejects.toThrow();

    expect(f.daemon.containers.has(START_CONTAINER)).toBe(true);
    expect(f.attempt()).toEqual(retained);
    expect(f.daemon.requests.slice(count).some(({ method }) => method === 'DELETE')).toBe(false);
  },
);

it('does not turn unknown absence into proof that a delayed create cannot arrive', async () => {
  const f = await interrupted('response');
  f.daemon.removeContainer(START_CONTAINER);
  const retained = f.attempt();

  await expect(
    f.owner.stopUserContainer({ userId: START_USER, reason: 'admin', allowMissingInstance: true }),
  ).rejects.toThrow();

  expect(f.attempt()).toEqual(retained);
  expect(f.daemon.networks.has(START_NETWORK)).toBe(true);
  expect(f.database.prepare('SELECT * FROM instances').all()).toEqual([]);
});

it('resumes exact-ID absence after physical cleanup but failed audit commit under another owner', async () => {
  const f = await interrupted();
  f.database.exec(`CREATE TRIGGER reject_recovery BEFORE INSERT ON audit_events
    WHEN NEW.event_type='instance.start-failed' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);

  await expect(
    f.owner.stopUserContainer({ userId: START_USER, reason: 'admin', allowMissingInstance: true }),
  ).rejects.toThrow();

  expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
  expect(f.attempt()).toBeDefined();
  expect(f.database.prepare('SELECT * FROM instances').all()).toEqual([]);
  f.database.exec('DROP TRIGGER reject_recovery');
  await f.fresh().reconcile();
  await f.fresh().reconcile();
  expect(f.attempt()).toBeUndefined();
  expect(f.database.prepare('SELECT event_type FROM audit_events').all()).toEqual([
    { event_type: 'instance.start-failed' },
  ]);
});

it('retains a learned identity across network cleanup failure without repeating container deletion', async () => {
  const f = await interrupted('response');
  f.daemon.overrides.set(`DELETE /networks/${START_NETWORK}`, { status: 500 });

  await expect(
    f.owner.stopUserContainer({ userId: START_USER, reason: 'admin', allowMissingInstance: true }),
  ).rejects.toThrow();

  expect(f.database.prepare('SELECT container_id FROM creation_attempts').get()).toEqual({
    container_id: START_CONTAINER,
  });
  expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
  f.daemon.overrides.clear();
  const count = f.daemon.requests.length;
  await f.fresh().reconcile();
  expect(
    f.daemon.requests
      .slice(count)
      .some(({ method, path }) => method === 'DELETE' && path.startsWith('/containers/')),
  ).toBe(false);
  expect(f.attempt()).toBeUndefined();
});

it('rejects an invalid retirement reason before recovering a pending creation', async () => {
  const f = await interrupted();
  const retained = f.attempt();
  const count = f.daemon.requests.length;
  // Deliberately exercise a caller outside the TypeScript enum contract.
  const invalid = {
    userId: START_USER,
    reason: 'invalid',
    allowMissingInstance: true,
  } as unknown as StopUserContainerInput;

  await expect(f.owner.stopUserContainer(invalid)).rejects.toThrow();

  expect(f.attempt()).toEqual(retained);
  expect(f.daemon.containers.has(START_CONTAINER)).toBe(true);
  expect(f.daemon.requests.slice(count)).toEqual([]);
});
