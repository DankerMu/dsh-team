import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { containerId, object } from './identity.ts';
import { allocateSubnet } from './subnet.ts';

export interface OwnedNetwork {
  readonly id: string;
  readonly subnet: string;
  readonly created: boolean;
}

const MAX_NETWORK_BYTES = 4 * 1024 * 1024;
const nameFor = (userId: string) => `dsh-team-net-${userId}`;

function inspectedNetwork(document: unknown, userId: string, id?: string): OwnedNetwork {
  const row = object(document);
  const actual = containerId(row);
  const configs = object(row.IPAM).Config;
  if (!Array.isArray(configs) || configs.length !== 1)
    throw new Error('Invalid owned network IPAM');
  const subnet = object(configs[0]).Subnet;
  if (
    typeof subnet !== 'string' ||
    !subnet.endsWith('/28') ||
    allocateSubnet(subnet, []) !== subnet
  )
    throw new Error('Invalid owned network subnet');
  if (
    (id !== undefined && actual !== id) ||
    row.Name !== nameFor(userId) ||
    object(row.Labels)['dsh-team.user'] !== userId ||
    row.Driver !== 'bridge' ||
    row.Internal !== false ||
    row.EnableIPv6 !== false
  )
    throw new Error('Docker network ownership mismatch');
  object(row.Containers);
  return { id: actual, subnet, created: false };
}

function attachmentDocument(
  document: unknown,
  userId: string,
  created: boolean,
): { id: string; endpoint: Record<string, unknown> } {
  const row = object(document);
  const networks = object(object(row.NetworkSettings).Networks);
  const keys = Object.keys(networks);
  if (keys.length !== 1) throw new Error('Instance must have one owned network');
  const mode = containerId({ Id: object(row.HostConfig).NetworkMode });
  const key = keys[0] ?? '';
  if (key !== nameFor(userId) && (!created || key !== mode))
    throw new Error('Instance network name mismatch');
  const endpoint = object(networks[key]);
  // Before start Docker may expose only the immutable declaration, not a live endpoint ID.
  const id = containerId({ Id: created && endpoint.NetworkID === '' ? mode : endpoint.NetworkID });
  if (id !== mode) throw new Error('Instance declared network identity mismatch');
  return { id, endpoint };
}

export function attachedNetwork(
  document: unknown,
  userId: string,
  expected?: string,
  created = false,
): string {
  const { id, endpoint } = attachmentDocument(document, userId, created);
  if (expected !== undefined && id !== expected)
    throw new Error('Instance network identity changed');
  if (!created || endpoint.EndpointID !== '') containerId({ Id: endpoint.EndpointID });
  if (!Array.isArray(endpoint.Aliases) || !endpoint.Aliases.includes(`u-${userId}`))
    throw new Error('Instance hostname alias missing');
  return id;
}

function ownedEndpoints(document: unknown, userId: string, container?: string): void {
  const endpoints = object(object(document).Containers);
  const ids = Object.keys(endpoints);
  if (ids.length === 0) return;
  if (container === undefined || ids.length !== 1 || ids[0] !== container)
    throw new Error('Network has unknown endpoints');
  const endpoint = object(endpoints[container]);
  if (endpoint.Name !== `dsh-team-u-${userId}`)
    throw new Error('Network endpoint ownership mismatch');
}

async function inspect(client: DockerClient, target: string): Promise<unknown> {
  try {
    return await client.json('GET', `/networks/${target}`, undefined, undefined, MAX_NETWORK_BYTES);
  } catch (error) {
    if (error instanceof DockerHttpError && error.statusCode === 404) return undefined;
    throw error;
  }
}

async function requireCanonicalAbsent(client: DockerClient, userId: string): Promise<void> {
  if ((await inspect(client, nameFor(userId))) !== undefined)
    throw new Error('Canonical user network remains');
}

export async function captureUserNetwork(
  client: DockerClient,
  userId: string,
  container?: string,
): Promise<OwnedNetwork | undefined> {
  const document = await inspect(client, nameFor(userId));
  if (document === undefined) return undefined;
  const network = inspectedNetwork(document, userId);
  ownedEndpoints(document, userId, container);
  return network;
}

export async function validateUserNetwork(
  client: DockerClient,
  userId: string,
  document: unknown,
  expected?: string,
  created = false,
): Promise<OwnedNetwork> {
  const id = attachedNetwork(document, userId, expected, created);
  const network = await inspect(client, id);
  const owned = inspectedNetwork(network, userId, id);
  const container = containerId(document);
  ownedEndpoints(network, userId, container);
  const endpoints = object(object(network).Containers);
  if (!(container in endpoints)) {
    // A stopped or not-yet-started container can retain its declaration without a live endpoint.
    if (created && object(object(document).State).Running === false) return owned;
    throw new Error('Owned network endpoint missing');
  }
  const endpoint = object(object(object(document).NetworkSettings).Networks);
  const attachment = object(endpoint[nameFor(userId)]);
  const address = attachment.IPAddress;
  const base = owned.subnet.slice(0, -3);
  const lastDot = base.lastIndexOf('.');
  const prefix = base.slice(0, lastDot + 1);
  if (typeof address !== 'string' || !address.startsWith(prefix))
    throw new Error('Instance endpoint subnet mismatch');
  const host = Number(address.slice(prefix.length));
  const start = Number(base.slice(lastDot + 1));
  if (
    !Number.isInteger(host) ||
    host <= start ||
    host >= start + 15 ||
    address !== `${prefix}${String(host)}` ||
    object(endpoints[container]).IPv4Address !== `${address}/28` ||
    object(endpoints[container]).EndpointID !== attachment.EndpointID
  )
    throw new Error('Instance endpoint address mismatch');
  return owned;
}

function occupiedSubnets(document: unknown): string[] {
  if (!Array.isArray(document)) throw new Error('Invalid Docker network inventory');
  const occupied: string[] = [];
  for (const entry of document) {
    containerId(entry);
    const configs = object(object(entry).IPAM).Config;
    if (configs === null) continue;
    if (!Array.isArray(configs)) throw new Error('Invalid Docker network IPAM inventory');
    for (const config of configs) {
      const subnet = object(config).Subnet;
      if (subnet === undefined || subnet === '') continue;
      if (typeof subnet !== 'string') throw new Error('Invalid Docker subnet inventory');
      // IPv6 ranges cannot occupy this IPv4 pool; IPv4 CIDRs are validated by allocateSubnet.
      if (!subnet.includes(':')) occupied.push(subnet);
    }
  }
  return occupied;
}

/** Called only inside the owner's short allocation queue, never during composition or start. */
export async function createUserNetwork(
  client: DockerClient,
  cleanup: DockerClient,
  userId: string,
  pool: string,
  reuse = false,
): Promise<OwnedNetwork> {
  const existing = await inspect(client, nameFor(userId));
  if (existing !== undefined) {
    if (!reuse) throw new Error('Canonical user network already exists');
    const network = inspectedNetwork(existing, userId);
    const current = await inspect(client, network.id);
    if (inspectedNetwork(current, userId, network.id).subnet !== network.subnet)
      throw new Error('Owned network subnet changed');
    ownedEndpoints(current, userId);
    return network;
  }
  const subnet = allocateSubnet(
    pool,
    occupiedSubnets(await client.json('GET', '/networks', undefined, undefined, MAX_NETWORK_BYTES)),
  );
  let id: string | undefined;
  try {
    id = containerId(
      await client.json('POST', '/networks/create', {
        Name: nameFor(userId),
        Driver: 'bridge',
        Internal: false,
        EnableIPv6: false,
        CheckDuplicate: true,
        Labels: { 'dsh-team.user': userId },
        IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] },
      }),
    );
    const document = await inspect(client, id);
    const network = inspectedNetwork(document, userId, id);
    if (network.subnet !== subnet) throw new Error('Allocated subnet changed');
    ownedEndpoints(document, userId);
    return { ...network, created: true };
  } catch (error) {
    if (id !== undefined) {
      try {
        await removeUserNetwork(cleanup, userId, () => undefined, undefined, { id, subnet });
      } catch {
        throw new Error('Network allocation and rollback failed');
      }
    }
    throw error;
  }
}

/** Verify before every destructive step; disconnect only a confirmed stopped owned endpoint. */
export async function removeUserNetwork(
  client: DockerClient,
  userId: string,
  current: () => void,
  stoppedContainer: string | undefined,
  captured: Pick<OwnedNetwork, 'id' | 'subnet'>,
): Promise<void> {
  current();
  const found = await inspect(client, captured.id);
  if (found === undefined) {
    await requireCanonicalAbsent(client, userId);
    current();
    return;
  }
  const network = inspectedNetwork(found, userId, captured.id);
  if (captured.subnet !== network.subnet) throw new Error('Captured network subnet changed');
  ownedEndpoints(found, userId, stoppedContainer);
  current();
  if (Object.keys(object(object(found).Containers)).length !== 0) {
    await client.json('POST', `/networks/${network.id}/disconnect`, {
      Container: stoppedContainer,
      Force: false,
    });
  }
  current();
  const empty = await inspect(client, network.id);
  if (empty !== undefined) {
    if (inspectedNetwork(empty, userId, network.id).subnet !== network.subnet)
      throw new Error('Owned network subnet changed');
    ownedEndpoints(empty, userId);
    current();
    try {
      await client.json('DELETE', `/networks/${network.id}`);
    } catch (error) {
      if (!(error instanceof DockerHttpError) || error.statusCode !== 404) throw error;
    }
  }
  current();
  if ((await inspect(client, network.id)) !== undefined) throw new Error('Owned network remains');
  await requireCanonicalAbsent(client, userId);
  current();
}
