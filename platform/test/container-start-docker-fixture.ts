import { request } from 'node:http';
import { arch, platform } from 'node:os';
import { expect } from 'vitest';
import { createDockerClient } from '../src/orchestrator/index.ts';
import type { Orchestrator } from '../src/orchestrator/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { START_MODEL } from './container-start-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
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

export function inspectNetwork(lifecycle: UserImageLifecycle, id: string): Record<string, unknown> {
  const result = lifecycle.command(['network', 'inspect', id], 15_000);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Independent network inspect failed');
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Network inspect unavailable');
  return record(rows[0]);
}

export function createStandInPlatform(lifecycle: UserImageLifecycle, name: string) {
  lifecycle.registerResource('container', name, { 'dsh-team.test-run': lifecycle.runId });
  const result = lifecycle.command(
    [
      'run',
      '--detach',
      '--name',
      name,
      '--network',
      'bridge',
      '--label',
      `dsh-team.test-run=${lifecycle.runId}`,
      lifecycle.imageId,
      'sleep',
      'infinity',
    ],
    30_000,
  );
  if (result.status !== 0 || result.error !== undefined) throw new Error('Stand-in startup failed');
  const container = inspect(lifecycle, name);
  expect(container.Image).toBe(lifecycle.imageId);
  return container;
}

export function platformHttpStatus(
  lifecycle: UserImageLifecycle,
  id: string,
  host: string,
  authority: string,
  cookie = '',
): number {
  const script = `
import urllib.request, urllib.error, sys
request = urllib.request.Request('http://' + sys.argv[1] + ':3080/', headers={'Host': sys.argv[2], 'Cookie': sys.argv[3]})
try:
    response = urllib.request.urlopen(request, timeout=5)
    print(response.status)
except urllib.error.HTTPError as error:
    print(error.code)
`;
  const result = lifecycle.command(
    ['exec', id, 'python3', '-c', script, host, authority, cookie],
    10_000,
  );
  if (result.status !== 0 || result.error !== undefined || !/^\d{3}$/.test(result.stdout.trim()))
    throw new Error('Stand-in HTTP connection failed');
  return Number(result.stdout.trim());
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

/** Registration precedes every production mutation and keeps the existing exact cleanup authority. */
export function registerStartupUsers(
  lifecycle: UserImageLifecycle,
  database: DatabaseHandle,
  users: readonly string[],
  emailDomain: string,
): void {
  for (const user of users) {
    const ownership = { 'dsh-team.user': user };
    lifecycle.registerResource('container', `dsh-team-u-${user}`, ownership);
    lifecycle.registerResource('volume', `dsh-team-home-${user}`, ownership);
    lifecycle.registerResource('volume', `dsh-team-work-${user}`, ownership);
    database
      .prepare("INSERT INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
      .run(user, `${user}@${emailDomain}`);
  }
}

/** Only common production input/launch is shared; protocol and isolation assertions remain independent. */
export async function startDockerInstance(
  owner: Orchestrator,
  lifecycle: UserImageLifecycle,
  userId: string,
  authority: string,
) {
  const result = await owner.startUserContainer({
    userId,
    config: {
      userImage: lifecycle.imageId,
      seccompProfilePath: lifecycle.seccomp,
      managedConfigDir: lifecycle.overlayDirectory,
      authority,
      subnetPool: '172.30.0.0/16',
    },
    modelSettings: START_MODEL,
    modelKey: 'docker-acceptance-only-not-a-model-credential',
  });
  if (result.outcome !== 'starting') throw new Error('Production instance did not start');
  await owner.waitForUserContainerReady({ userId, authority });
  return result;
}

export async function runNetworkAcceptance(
  scenario: (lifecycle: UserImageLifecycle) => Promise<string>,
  evidenceName: string,
  assertSummary: (summary: string) => void,
): Promise<void> {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  const result = await runUserImage('container-start', assertSummary, undefined, scenario);
  process.stdout.write(
    `Docker ${evidenceName} verified: run=${result.runId} image=${result.image} readback=${result.stdout} cleanup=complete\n`,
  );
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
