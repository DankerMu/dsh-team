import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { allocateSubnet, createDockerClient, DockerHttpError } from '../src/orchestrator/index.ts';
import { isAbsentResource } from './docker-command.ts';
import { inspectNetwork, record, runNetworkAcceptance } from './container-start-docker-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

interface Bridge {
  name: string;
  id: string;
  subnet: string;
}

function invocationIds(lifecycle: UserImageLifecycle): string[] {
  const result = lifecycle.command(
    [
      'network',
      'ls',
      '--filter',
      `label=dsh-team.test-run=${lifecycle.runId}`,
      '--quiet',
      '--no-trunc',
    ],
    15_000,
  );
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Independent invocation network inventory failed');
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split(/\r?\n/).sort();
}

function observe(lifecycle: UserImageLifecycle, bridge: Bridge): number {
  const network = inspectNetwork(lifecycle, bridge.id);
  expect(network).toMatchObject({
    Id: bridge.id,
    Name: bridge.name,
    Driver: 'bridge',
    Internal: false,
    EnableIPv6: false,
  });
  expect(network.Labels).toEqual({ 'dsh-team.test-run': lifecycle.runId });
  expect(record(network.Containers)).toEqual({});
  expect(record(network.IPAM).Config).toEqual([expect.objectContaining({ Subnet: bridge.subnet })]);
  expect(inspectNetwork(lifecycle, bridge.name)).toEqual(network);
  // Independent /16 containment, /28 size and alignment oracle: no allocator/parser reuse.
  expect(bridge.subnet).toMatch(/^172\.30\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\/28$/);
  const octets = bridge.subnet.split('/')[0]?.split('.').map(Number);
  if (octets?.[2] === undefined || octets[3] === undefined)
    throw new Error('Missing observed IPv4 octets');
  expect(octets[2]).toBeLessThanOrEqual(255);
  expect(octets[3]).toBeLessThanOrEqual(240);
  expect(octets[3] % 16).toBe(0);
  return octets[2] * 256 + octets[3];
}

async function capacity(lifecycle: UserImageLifecycle): Promise<string> {
  const config = loadConfig({ PLATFORM_PUBLIC_URL: 'https://capacity.example' });
  expect(config.subnetPool).toBe('172.30.0.0/16');
  const client = createDockerClient(config.dockerSocketPath);
  const bridges: Bridge[] = [];
  const labels = { 'dsh-team.test-run': lifecycle.runId };
  for (let index = 0; index < 61; index += 1) {
    const name = `dsh-team-test-run-${lifecycle.runId}-network-${String(index)}`;
    lifecycle.registerResource('network', name, labels);
    const inventory = await client.json('GET', '/networks', undefined, AbortSignal.timeout(15_000));
    if (!Array.isArray(inventory)) throw new Error('All-network IPAM inventory unavailable');
    const occupied = inventory.flatMap((entry: unknown) => {
      const configs = record(record(entry).IPAM).Config;
      if (configs === undefined || configs === null) return [];
      if (!Array.isArray(configs)) throw new Error('All-network IPAM configuration malformed');
      return configs.flatMap((value: unknown) => {
        const subnet = record(value).Subnet;
        if (subnet === undefined) return [];
        if (typeof subnet !== 'string' || subnet === '')
          throw new Error('Occupied subnet malformed');
        return [subnet];
      });
    });
    const subnet = allocateSubnet(config.subnetPool, occupied);
    const created = record(
      await client.json(
        'POST',
        '/networks/create',
        {
          Name: name,
          Driver: 'bridge',
          Internal: false,
          EnableIPv6: false,
          Labels: labels,
          IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] },
        },
        AbortSignal.timeout(15_000),
      ),
    );
    if (typeof created.Id !== 'string' || !/^[a-f0-9]{64}$/.test(created.Id))
      throw new Error('Network create missing immutable ID');
    bridges.push({ name, id: created.Id, subnet });
  }

  // Nothing is retired until these independent inspections prove all 61 coexist.
  expect(bridges).toHaveLength(61);
  const ids = bridges.map(({ id }) => id).sort();
  expect(new Set(ids).size).toBe(61);
  expect(new Set(bridges.map(({ subnet }) => subnet)).size).toBe(61);
  expect(invocationIds(lifecycle)).toEqual(ids);
  const before = bridges.map((bridge) => inspectNetwork(lifecycle, bridge.id));
  const bases = bridges.map((bridge) => observe(lifecycle, bridge)).sort((a, b) => a - b);
  for (let index = 1; index < bases.length; index += 1) {
    const previous = bases[index - 1];
    const current = bases[index];
    if (previous === undefined || current === undefined) throw new Error('Missing subnet range');
    expect(current).toBeGreaterThanOrEqual(previous + 16);
  }

  const first = bridges[0];
  if (first === undefined) throw new Error('Missing overlap control subnet');
  const rejectedName = `dsh-team-test-run-${lifecycle.runId}-overlap`;
  lifecycle.registerResource('network', rejectedName, labels);
  const rejected: unknown = await client
    .json(
      'POST',
      '/networks/create',
      {
        Name: rejectedName,
        Driver: 'bridge',
        Internal: false,
        EnableIPv6: false,
        Labels: labels,
        IPAM: { Driver: 'default', Config: [{ Subnet: first.subnet }] },
      },
      AbortSignal.timeout(15_000),
    )
    .catch((error: unknown) => error);
  if (!(rejected instanceof DockerHttpError))
    throw new Error('Overlap control did not return a definitive Docker HTTP rejection', {
      cause: rejected,
    });
  expect(rejected.statusCode).toBe(403);
  expect(
    isAbsentResource(
      lifecycle.command(['network', 'inspect', rejectedName], 15_000),
      'network',
      rejectedName,
    ),
  ).toBe(true);
  expect(invocationIds(lifecycle)).toEqual(ids);
  expect(bridges.map((bridge) => inspectNetwork(lifecycle, bridge.id))).toEqual(before);

  for (const bridge of bridges) lifecycle.removeNetwork(bridge.name, bridge.id);
  for (const target of [...bridges.flatMap(({ name, id }) => [name, id]), rejectedName]) {
    expect(
      isAbsentResource(
        lifecycle.command(['network', 'inspect', target], 15_000),
        'network',
        target,
      ),
    ).toBe(true);
  }
  expect(invocationIds(lifecycle)).toEqual([]);
  return JSON.stringify({
    liveBridges: 61,
    pool: config.subnetPool,
    prefix: 28,
    overlapRejected: true,
    overlapStatus: rejected.statusCode,
    goodBridgesPreserved: true,
    networksAbsent: true,
  });
}

it('the default pool supports 61 simultaneous nonoverlapping bridges and rejects overlap without disturbing them', async () => {
  await runNetworkAcceptance(capacity, 'network capacity', (summary) => {
    expect(JSON.parse(summary)).toEqual({
      liveBridges: 61,
      pool: '172.30.0.0/16',
      prefix: 28,
      overlapRejected: true,
      overlapStatus: 403,
      goodBridgesPreserved: true,
      networksAbsent: true,
    });
  });
});
