import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  START_NETWORK,
  START_USER,
  startupOwnerFixture,
} from '../../test/container-start-fixture.ts';
import type { StartupOwnerFixture } from '../../test/container-start-fixture.ts';

let fixture: StartupOwnerFixture;
beforeEach(async () => {
  fixture = await startupOwnerFixture();
});
afterEach(async () => {
  fixture.database.close();
  await rm(fixture.root, { recursive: true, force: true });
});

it.each([null, {}, { Id: 'mutable-image-tag' }, { Id: `sha256:${'z'.repeat(64)}` }])(
  'rejects non-immutable image identity %j before volumes, network or container creation',
  async (document) => {
    fixture.daemon.overrides.set('GET /images/dsh-team-user%3Alocal/json', {
      status: 200,
      document,
    });

    await expect(fixture.owner.startUserContainer(fixture.input)).rejects.toThrow(
      'image resolution',
    );

    expect(fixture.database.prepare('SELECT * FROM instances').all()).toEqual([]);
    expect(fixture.daemon.containers.size).toBe(0);
    expect([...fixture.daemon.networks.keys()]).toEqual(['0'.repeat(64)]);
    expect(fixture.daemon.requests.every(({ method }) => method === 'GET')).toBe(true);
  },
);

it.each([null, {}, { Id: 'container-name' }, { Id: 'A'.repeat(64) }])(
  'rejects unconfirmed container identity %j and retains its captured network for safe recovery',
  async (document) => {
    fixture.daemon.overrides.set(`POST /containers/create?name=dsh-team-u-${START_USER}`, {
      status: 201,
      document,
    });

    await expect(fixture.owner.startUserContainer(fixture.input)).rejects.toThrow(
      'container creation',
    );

    expect(fixture.database.prepare('SELECT * FROM instances').all()).toEqual([]);
    expect(fixture.daemon.networks.get(START_NETWORK)?.Containers).toEqual({});
    expect(
      fixture.daemon.requests.some(
        ({ method, path }) => method === 'DELETE' && path.startsWith('/networks'),
      ),
    ).toBe(false);
  },
);
