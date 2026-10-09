import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { containerId, object } from './identity.ts';
import { allocateSubnet } from './subnet.ts';
import { platformMembership, validateEndpointAddress, verifiedPlatform } from './transport.ts';
import type { PlatformEndpoint, TransportContext } from './transport.ts';

export interface OwnedNetwork {
  readonly id: string;
  readonly subnet: string;
  readonly created: boolean;
}

export class NetworkCreationUnconfirmedError extends Error {
  constructor() {
    super('Network creation outcome unconfirmed');
  }
}

const MAX_NETWORK_BYTES = 4 * 1024 * 1024;
// An accepted platform mutation and its inspect agreement share one independent settlement deadline.
const ATTACH_TIMEOUT_MS = 10_000;
const nameFor = (userId: string) => `dsh-team-net-${userId}`;

export function inspectedNetwork(document: unknown, userId: string, id?: string): OwnedNetwork {
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

/** A verified stopped instance may retain only its immutable bridge declaration after detachment. */
export function stoppedNetwork(document: unknown, userId: string): string {
  const row = object(document);
  if (object(row.State).Running !== false)
    throw new Error('Detached instance must be confirmed stopped');
  const declared = containerId({ Id: object(row.HostConfig).NetworkMode });
  const networks = object(object(row.NetworkSettings).Networks);
  if (Object.keys(networks).length === 0) return declared;
  return attachedNetwork(row, userId, declared, true);
}

function ownedEndpoints(
  document: unknown,
  userId: string,
  container?: string,
  platform?: PlatformEndpoint,
): void {
  if (container !== undefined && platform?.id === container)
    throw new Error('Platform and instance identities must be distinct');
  const endpoints = object(object(document).Containers);
  for (const id of Object.keys(endpoints)) {
    const expected =
      id === container ? `dsh-team-u-${userId}` : id === platform?.id ? platform.name : undefined;
    if (expected === undefined) throw new Error('Network has unknown endpoints');
    if (object(endpoints[id]).Name !== expected)
      throw new Error('Network endpoint ownership mismatch');
  }
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
  transport: TransportContext,
  container: string | undefined,
  expected: string | undefined,
): Promise<OwnedNetwork | undefined> {
  const document = await inspect(client, nameFor(userId));
  if (document === undefined) {
    if (expected !== undefined && (await inspect(client, expected)) !== undefined)
      throw new Error('Declared user network remains without canonical identity');
    return undefined;
  }
  const network = inspectedNetwork(document, userId, expected);
  const platform = await verifiedPlatform(client, transport, false);
  ownedEndpoints(document, userId, container, platform);
  if (platform !== undefined) platformMembership(platform, document, userId, network.subnet, false);
  return network;
}

export async function validateUserNetwork(
  client: DockerClient,
  userId: string,
  document: unknown,
  transport: TransportContext,
  expected?: string,
  created = false,
  requirePlatform = !created,
): Promise<OwnedNetwork> {
  const id = attachedNetwork(document, userId, expected, created);
  const network = await inspect(client, id);
  const owned = inspectedNetwork(network, userId, id);
  const container = containerId(document);
  const platform = await verifiedPlatform(client, transport, requirePlatform);
  ownedEndpoints(network, userId, container, platform);
  if (platform !== undefined)
    platformMembership(platform, network, userId, owned.subnet, requirePlatform);
  const endpoints = object(object(network).Containers);
  if (!(container in endpoints)) {
    // A stopped or not-yet-started container can retain its declaration without a live endpoint.
    if (created && object(object(document).State).Running === false) return owned;
    throw new Error('Owned network endpoint missing');
  }
  const endpoint = object(object(object(document).NetworkSettings).Networks);
  const attachment = object(endpoint[nameFor(userId)]);
  validateEndpointAddress(attachment, object(endpoints[container]), owned.subnet);
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
      // The allocator validates every CIDR and geometrically ignores valid IPv6 ranges.
      occupied.push(subnet);
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
  transport: TransportContext,
  signal: AbortSignal,
  reuse = false,
): Promise<OwnedNetwork> {
  const existing = await inspect(client, nameFor(userId));
  if (existing !== undefined) {
    if (!reuse) throw new Error('Canonical user network already exists');
    const network = inspectedNetwork(existing, userId);
    const current = await inspect(client, network.id);
    if (inspectedNetwork(current, userId, network.id).subnet !== network.subnet)
      throw new Error('Owned network subnet changed');
    const platform = await verifiedPlatform(client, transport, true);
    ownedEndpoints(current, userId, undefined, platform);
    if (platform !== undefined)
      platformMembership(platform, current, userId, network.subnet, false);
    return network;
  }
  const subnet = allocateSubnet(
    pool,
    occupiedSubnets(await client.json('GET', '/networks', undefined, undefined, MAX_NETWORK_BYTES)),
  );
  let id: string | undefined;
  signal.throwIfAborted();
  try {
    id = containerId(
      // Once submitted, caller cancellation cannot discard the response identity or advance the queue.
      await cleanup.json('POST', '/networks/create', {
        Name: nameFor(userId),
        Driver: 'bridge',
        Internal: false,
        EnableIPv6: false,
        CheckDuplicate: true,
        Labels: { 'dsh-team.user': userId },
        IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] },
      }),
    );
    signal.throwIfAborted();
    const document = await inspect(client, id);
    const network = inspectedNetwork(document, userId, id);
    if (network.subnet !== subnet) throw new Error('Allocated subnet changed');
    ownedEndpoints(document, userId);
    return { ...network, created: true };
  } catch (error) {
    if (id === undefined) {
      // A rejected daemon response remains a known error; transport/deadline/identity loss is uncertain.
      if (error instanceof DockerHttpError) throw error;
      throw new NetworkCreationUnconfirmedError();
    }
    try {
      await removeUserNetwork(cleanup, userId, transport, () => undefined, undefined, {
        id,
        subnet,
      });
    } catch {
      throw new Error('Network allocation and rollback failed');
    }
    throw error;
  }
}

async function disconnectPlatform(
  client: DockerClient,
  transport: TransportContext,
  userId: string,
  network: OwnedNetwork,
  platform: PlatformEndpoint,
): Promise<void> {
  let failure: unknown;
  try {
    await client.json('POST', `/networks/${network.id}/disconnect`, {
      Container: platform.id,
      Force: false,
    });
  } catch (error) {
    failure = error;
  }
  const settled = await inspect(client, network.id);
  const confirmed = await verifiedPlatform(client, transport, false);
  if (confirmed === undefined || settled === undefined)
    throw new Error('Platform disconnection outcome unconfirmed');
  if (inspectedNetwork(settled, userId, network.id).subnet !== network.subnet)
    throw new Error('Captured network subnet changed');
  if (platformMembership(confirmed, settled, userId, network.subnet, false)) {
    if (failure instanceof Error) throw failure;
    throw new Error('Platform endpoint remains');
  }
}

/** Delete only the freshly inspected empty captured bridge, after optional orphan absence fencing. */
async function deleteEmptyUserNetwork(
  client: DockerClient,
  userId: string,
  network: OwnedNetwork,
  current: () => void,
  verifyAbsence?: () => Promise<void>,
): Promise<void> {
  current();
  const empty = await inspect(client, network.id);
  if (empty === undefined) return;
  if (inspectedNetwork(empty, userId, network.id).subnet !== network.subnet)
    throw new Error('Owned network subnet changed');
  ownedEndpoints(empty, userId);
  current();
  await verifyAbsence?.();
  try {
    await client.json('DELETE', `/networks/${network.id}`);
  } catch (error) {
    if (!(error instanceof DockerHttpError) || error.statusCode !== 404) throw error;
  }
}

/** Verify before every destructive step; disconnect only a confirmed stopped owned endpoint. */
export async function removeUserNetwork(
  client: DockerClient,
  userId: string,
  transport: TransportContext,
  current: () => void,
  stoppedContainer: string | undefined,
  captured: Pick<OwnedNetwork, 'id' | 'subnet'>,
  verifyAbsence?: () => Promise<void>,
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
  const platform = await verifiedPlatform(client, transport, false);
  ownedEndpoints(found, userId, stoppedContainer, platform);
  const attached =
    platform === undefined
      ? false
      : platformMembership(platform, found, userId, network.subnet, false);
  current();
  if (stoppedContainer !== undefined && stoppedContainer in object(object(found).Containers)) {
    await client.json('POST', `/networks/${network.id}/disconnect`, {
      Container: stoppedContainer,
      Force: false,
    });
  }
  if (attached && platform !== undefined) {
    await verifyAbsence?.();
    current();
    await disconnectPlatform(client, transport, userId, network, platform);
  }
  await deleteEmptyUserNetwork(client, userId, network, current, verifyAbsence);
  current();
  if ((await inspect(client, network.id)) !== undefined) throw new Error('Owned network remains');
  await requireCanonicalAbsent(client, userId);
  current();
}

/** The caller supplies its independent bounded settlement client, never its cancellation signal. */
export async function attachPlatform(
  raw: DockerClient,
  transport: TransportContext,
  userId: string,
  container: string,
  captured: OwnedNetwork,
  current: () => void = () => undefined,
  verify?: () => Promise<void>,
): Promise<void> {
  const signal = AbortSignal.timeout(ATTACH_TIMEOUT_MS);
  const client: DockerClient = {
    ...raw,
    json: (method, path, body, _signal, maxBytes) => raw.json(method, path, body, signal, maxBytes),
  };
  const platform = await verifiedPlatform(client, transport, true);
  if (platform === undefined) return;
  const before = await inspect(client, captured.id);
  const network = inspectedNetwork(before, userId, captured.id);
  if (network.subnet !== captured.subnet) throw new Error('Captured network subnet changed');
  ownedEndpoints(before, userId, container, platform);
  if (!platformMembership(platform, before, userId, network.subnet, false)) {
    await verify?.();
    current();
    // Do not drop submitted mutation ownership on abort or on a lost response.
    try {
      await client.json('POST', `/networks/${network.id}/connect`, { Container: platform.id });
    } catch {
      // Only independent agreement below can settle a lost/rejected connect response.
    }
  }
  const after = await inspect(client, network.id);
  if (inspectedNetwork(after, userId, network.id).subnet !== network.subnet)
    throw new Error('Captured network subnet changed');
  const confirmed = await verifiedPlatform(client, transport, true);
  if (confirmed === undefined) throw new Error('Platform attachment outcome unconfirmed');
  ownedEndpoints(after, userId, container, confirmed);
  platformMembership(confirmed, after, userId, network.subnet, true);
  current();
}
