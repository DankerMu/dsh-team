import { request } from 'node:http';
import { expect } from 'vitest';
import { createDockerClient } from '../src/orchestrator/index.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid acceptance inspect');
  // Docker JSON crosses an external boundary; callers assert each consumed field.
  return value as Record<string, unknown>;
}

export function inspect(lifecycle: UserImageLifecycle, name: string): Record<string, unknown> {
  const result = lifecycle.command(['container', 'inspect', name], 15_000);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Independent container inspect failed');
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('Independent inspect missing container');
  return record(rows[0]);
}

/** Normalize only incidental mount ordering; preserve every mount and other inspect attribute. */
export function normalizeInspectMounts(
  container: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(container.Mounts)) throw new Error('Container mount inventory unavailable');
  const mounts = container.Mounts.map((value: unknown) => {
    const mount = record(value);
    if (typeof mount.Destination !== 'string' || mount.Destination === '')
      throw new Error('Container mount destination unavailable');
    // The boundary check proves Destination; the indexed JSON record cannot express that field.
    return mount as Record<string, unknown> & { Destination: string };
  });
  mounts.sort((left, right) =>
    left.Destination < right.Destination ? -1 : left.Destination > right.Destination ? 1 : 0,
  );
  return { ...container, Mounts: mounts };
}

function registerCreatedNetwork(lifecycle: UserImageLifecycle, body: unknown): void {
  const network = record(body);
  const labels = record(network.Labels);
  const user = labels['dsh-team.user'];
  if (typeof user !== 'string' || network.Name !== `dsh-team-net-${user}`)
    throw new Error('Network registration ownership mismatch');
  lifecycle.registerResource('network', network.Name, { 'dsh-team.user': user });
}

/** Shared actual-start transport: registers production helpers before their create request. */
export function startupClient(lifecycle: UserImageLifecycle) {
  const raw = createDockerClient('/var/run/docker.sock');
  const helperIds: string[] = [];
  const requests: { method: string; path: string }[] = [];
  const client: typeof raw = {
    logs: (path, signal) => raw.logs(path, signal),
    async json(method, path, body, signal, maxBytes) {
      requests.push({ method, path });
      if (method === 'POST' && path === '/networks/create') registerCreatedNetwork(lifecycle, body);
      const helperCreate =
        method === 'POST' && path.startsWith('/containers/create?name=dsh-team-compose-');
      let helperName = '';
      let userId = '';
      if (helperCreate) {
        helperName = new URL(`http://docker${path}`).searchParams.get('name') ?? '';
        const labels = record(record(body).Labels);
        const invocation = labels['dsh-team.invocation'];
        const user = labels['dsh-team.user'];
        if (typeof invocation !== 'string' || typeof user !== 'string')
          throw new Error('Helper ownership missing');
        userId = user;
        lifecycle.registerResource('container', helperName, {
          'dsh-team.user': userId,
          'dsh-team.role': 'managed-composition',
          'dsh-team.invocation': invocation,
        });
      }
      const deadline = AbortSignal.timeout(30_000);
      const result = await raw.json(
        method,
        path,
        body,
        signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
        maxBytes,
      );
      if (helperCreate) {
        const helper = inspect(lifecycle, helperName);
        expect(helper.Image).toBe(lifecycle.imageId);
        const configuration = record(helper.Config);
        expect(configuration.User).toBe('1001');
        expect(configuration.Env).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^DMXAPI_KEY=/)]),
        );
        const host = record(helper.HostConfig);
        expect(host.NetworkMode).toBe('none');
        expect(host.Privileged).toBe(false);
        expect(
          host.PortBindings === null || Object.keys(record(host.PortBindings)).length === 0,
        ).toBe(true);
        expect(helper.Mounts).toEqual([
          expect.objectContaining({
            Type: 'volume',
            Name: `dsh-team-home-${userId}`,
            Destination: '/data/home',
            RW: true,
          }),
        ]);
        helperIds.push(String(helper.Id));
      }
      return result;
    },
  };
  return { raw, client, helperIds, requests };
}

export async function cookieHttpStatus(
  port: number,
  authority: string,
  cookie: string,
): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const outgoing = request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/',
      headers: { Host: authority, Cookie: cookie },
      signal: AbortSignal.timeout(5000),
    },
    (response) => {
      resolve(response.statusCode ?? 0);
      response.destroy();
    },
  );
  outgoing.on('error', () => {
    reject(new Error('Independent authenticated HTTP failed'));
  });
  try {
    outgoing.end();
    return await promise;
  } finally {
    outgoing.destroy();
  }
}
