import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { containerId, object } from './identity.ts';
import { allocateSubnet, instanceAddressLayout } from './subnet.ts';
import { documentServerPeer } from './document-server.ts';
import { endpointMembership, validateEndpointAddress, verifiedPlatform } from './transport.ts';
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

/** A definitive connect reply plus fresh absence in both inspect views, not transport uncertainty. */
export class PlatformAttachmentFailedError extends Error {
  constructor() {
    super('Configured platform attachment confirmed absent after connect');
  }
}

const MAX_NETWORK_BYTES = 4 * 1024 * 1024;
// An accepted platform mutation and its inspect agreement share one independent settlement deadline.
const ATTACH_TIMEOUT_MS = 10_000;
const nameFor = (userId: string) => `dsh-team-net-${userId}`;

/** Exactly the canonical /28 subnets an instance address layout exists for. */
export function isInstanceSubnet(subnet: unknown): subnet is string {
  if (typeof subnet !== 'string') return false;
  try {
    instanceAddressLayout(subnet);
    return true;
  } catch {
    return false;
  }
}

export function inspectedNetwork(document: unknown, userId: string, id?: string): OwnedNetwork {
  const row = object(document);
  const actual = containerId(row);
  const configs = object(row.IPAM).Config;
  if (!Array.isArray(configs) || configs.length !== 1)
    throw new Error('Invalid owned network IPAM');
  const subnet = object(configs[0]).Subnet;
  if (!isInstanceSubnet(subnet)) throw new Error('Invalid owned network subnet');
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

/** Only the exact recorded Document Server ID is admitted; its name and address grant nothing. */
function ownedEndpoints(
  document: unknown,
  userId: string,
  container: string | undefined,
  platform: PlatformEndpoint | undefined,
  documentServer: string | null,
): void {
  if (container !== undefined && platform?.id === container)
    throw new Error('Platform and instance identities must be distinct');
  if (documentServer !== null && (documentServer === container || documentServer === platform?.id))
    throw new Error('Document Server identity must be distinct');
  const endpoints = object(object(document).Containers);
  for (const id of Object.keys(endpoints)) {
    if (id === documentServer) continue;
    const expected =
      id === container ? `dsh-team-u-${userId}` : id === platform?.id ? platform.name : undefined;
    if (expected === undefined) throw new Error('Network has unknown endpoints');
    if (object(endpoints[id]).Name !== expected)
      throw new Error('Network endpoint ownership mismatch');
  }
}

/** Whether the recorded Document Server is on the bridge, live or as a stopped attachment. */
async function recordedMembership(
  client: DockerClient,
  network: unknown,
  userId: string,
  subnet: string,
  documentServer: string | null,
  declaration: 'checked' | 'ignored',
  required = false,
): Promise<boolean> {
  if (documentServer === null) return false;
  const peer = await documentServerPeer(client, documentServer, network);
  if (peer === undefined) {
    if (required) throw new Error('Recorded Document Server endpoint missing');
    return false;
  }
  return endpointMembership(peer, 'documentServer', network, userId, subnet, required, declaration);
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
  documentServer: string | null,
  declaration: 'checked' | 'ignored' = 'checked',
): Promise<OwnedNetwork | undefined> {
  const document = await inspect(client, nameFor(userId));
  if (document === undefined) {
    if (expected !== undefined && (await inspect(client, expected)) !== undefined)
      throw new Error('Declared user network remains without canonical identity');
    return undefined;
  }
  const network = inspectedNetwork(document, userId, expected);
  const platform = await verifiedPlatform(client, transport, false);
  ownedEndpoints(document, userId, container, platform, documentServer);
  if (platform !== undefined)
    endpointMembership(platform, 'platform', document, userId, network.subnet, false, declaration);
  await recordedMembership(client, document, userId, network.subnet, documentServer, declaration);
  return network;
}

export async function validateUserNetwork(
  client: DockerClient,
  userId: string,
  document: unknown,
  transport: TransportContext,
  documentServer: string | null,
  expected?: string,
  created = false,
  requirePlatform = !created,
  // Only started-container compensation ignores declarations, retaining the stage-1 range check.
  declaration: 'checked' | 'ignored' = 'checked',
  // Only the start that just attached it requires the recorded endpoint; elsewhere it may be gone.
  requireDocumentServer = false,
): Promise<OwnedNetwork> {
  const id = attachedNetwork(document, userId, expected, created);
  const network = await inspect(client, id);
  const owned = inspectedNetwork(network, userId, id);
  const container = containerId(document);
  const platform = await verifiedPlatform(client, transport, requirePlatform);
  ownedEndpoints(network, userId, container, platform, documentServer);
  if (platform !== undefined)
    endpointMembership(
      platform,
      'platform',
      network,
      userId,
      owned.subnet,
      requirePlatform,
      declaration,
    );
  await recordedMembership(
    client,
    network,
    userId,
    owned.subnet,
    documentServer,
    declaration,
    requireDocumentServer,
  );
  const endpoints = object(object(network).Containers);
  if (!(container in endpoints)) {
    // A stopped or not-yet-started container can retain its declaration without a live endpoint.
    if (created && object(object(document).State).Running === false) return owned;
    throw new Error('Owned network endpoint missing');
  }
  const endpoint = object(object(object(document).NetworkSettings).Networks);
  const attachment = object(endpoint[nameFor(userId)]);
  const declared = validateEndpointAddress(
    attachment,
    object(endpoints[container]),
    owned.subnet,
    declaration,
  );
  if (declared !== undefined && declared !== instanceAddressLayout(owned.subnet).container)
    throw new Error('Instance address differs from its layout');
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
  documentServer: string | null,
  // A replaced instance's prior record; only this start's decision may remain on the reused bridge.
  reuse?: { readonly previous: string | null },
): Promise<OwnedNetwork> {
  const existing = await inspect(client, nameFor(userId));
  if (existing !== undefined) {
    if (reuse === undefined) throw new Error('Canonical user network already exists');
    const network = inspectedNetwork(existing, userId);
    const current = await inspect(client, network.id);
    if (inspectedNetwork(current, userId, network.id).subnet !== network.subnet)
      throw new Error('Owned network subnet changed');
    const platform = await verifiedPlatform(client, transport, true);
    ownedEndpoints(current, userId, undefined, platform, documentServer);
    if (platform !== undefined)
      endpointMembership(platform, 'platform', current, userId, network.subnet, false);
    await recordedMembership(client, current, userId, network.subnet, documentServer, 'checked');
    if (
      reuse.previous !== null &&
      reuse.previous !== documentServer &&
      (await recordedMembership(client, current, userId, network.subnet, reuse.previous, 'ignored'))
    )
      throw new Error('Network has unknown endpoints');
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
    ownedEndpoints(document, userId, undefined, undefined, null);
    return { ...network, created: true };
  } catch (error) {
    if (id === undefined) {
      // A rejected daemon response remains a known error; transport/deadline/identity loss is uncertain.
      if (error instanceof DockerHttpError) throw error;
      throw new NetworkCreationUnconfirmedError();
    }
    try {
      await removeUserNetwork(
        cleanup,
        userId,
        transport,
        () => undefined,
        undefined,
        { id, subnet },
        null,
      );
    } catch {
      throw new Error('Network allocation and rollback failed');
    }
    throw error;
  }
}

/** Submit one non-forced disconnect; only a fresh settled inspection decides its outcome. */
async function settleDisconnection(
  client: DockerClient,
  userId: string,
  network: OwnedNetwork,
  peer: string,
  label: 'Platform' | 'Document Server',
  // Resolves the peer afresh: `undefined` when its identity cannot be confirmed.
  member: (settled: unknown) => Promise<boolean | undefined>,
): Promise<void> {
  let failure: unknown;
  try {
    await client.json('POST', `/networks/${network.id}/disconnect`, {
      Container: peer,
      Force: false,
    });
  } catch (error) {
    failure = error;
  }
  const settled = await inspect(client, network.id);
  if (settled === undefined) throw new Error(`${label} disconnection outcome unconfirmed`);
  if (inspectedNetwork(settled, userId, network.id).subnet !== network.subnet)
    throw new Error('Captured network subnet changed');
  const remaining = await member(settled);
  if (remaining === undefined) throw new Error(`${label} disconnection outcome unconfirmed`);
  if (remaining) {
    if (failure instanceof Error) throw failure;
    throw new Error(`${label} endpoint remains`);
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
  ownedEndpoints(empty, userId, undefined, undefined, null);
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
  // Retirement goes by the record alone, never by current settings or name resolution.
  documentServer: string | null,
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
  ownedEndpoints(found, userId, stoppedContainer, platform, documentServer);
  const attached =
    platform === undefined
      ? false
      : endpointMembership(platform, 'platform', found, userId, network.subnet, false, 'ignored');
  const recorded = await recordedMembership(
    client,
    found,
    userId,
    network.subnet,
    documentServer,
    'ignored',
  );
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
    await settleDisconnection(client, userId, network, platform.id, 'Platform', async (settled) => {
      const confirmed = await verifiedPlatform(client, transport, false);
      if (confirmed === undefined) return undefined;
      return endpointMembership(
        confirmed,
        'platform',
        settled,
        userId,
        network.subnet,
        false,
        'ignored',
      );
    });
  }
  if (recorded && documentServer !== null) {
    await verifyAbsence?.();
    current();
    // Docker removes a stopped peer's configured attachment too, so its next start cannot fail.
    await settleDisconnection(
      client,
      userId,
      network,
      documentServer,
      'Document Server',
      (settled) =>
        recordedMembership(client, settled, userId, network.subnet, documentServer, 'ignored'),
    );
  }
  await deleteEmptyUserNetwork(client, userId, network, current, verifyAbsence);
  current();
  if ((await inspect(client, network.id)) !== undefined) throw new Error('Owned network remains');
  await requireCanonicalAbsent(client, userId);
  current();
}

/** Confirm the captured bridge and configured immutable platform before interpreting either membership view. */
export async function inspectPlatformAttachment(
  client: DockerClient,
  transport: TransportContext,
  userId: string,
  container: string,
  captured: OwnedNetwork,
  documentServer: string | null,
): Promise<boolean> {
  return inspectAttachment(client, transport, userId, container, captured, documentServer, false);
}

/** One post-connect view: the platform's membership, or the recorded Document Server's. */
async function inspectAttachment(
  client: DockerClient,
  transport: TransportContext,
  userId: string,
  container: string,
  captured: OwnedNetwork,
  documentServer: string | null,
  peer: boolean,
): Promise<boolean> {
  const network = await inspect(client, captured.id);
  if (inspectedNetwork(network, userId, captured.id).subnet !== captured.subnet)
    throw new Error('Captured network subnet changed');
  const platform = await verifiedPlatform(client, transport, true);
  if (platform === undefined) throw new Error('Platform attachment outcome unconfirmed');
  ownedEndpoints(network, userId, container, platform, documentServer);
  if (peer)
    return recordedMembership(client, network, userId, captured.subnet, documentServer, 'checked');
  return endpointMembership(platform, 'platform', network, userId, captured.subnet, false);
}

/** Only an instance actually at its layout container address asks for the layout platform address. */
function connectRequest(
  network: unknown,
  container: string,
  platform: string,
  subnet: string,
): Record<string, unknown> {
  const endpoint = object(object(network).Containers)[container];
  if (endpoint === undefined) throw new Error('Owned network endpoint missing');
  const layout = instanceAddressLayout(subnet);
  // A stage-1 survivor elsewhere keeps the undeclared stage-1 attachment.
  if (object(endpoint).IPv4Address !== `${layout.container}/28`) return { Container: platform };
  return { Container: platform, EndpointConfig: { IPAMConfig: { IPv4Address: layout.platform } } };
}

interface AttachmentTarget {
  /** Preflight over the captured bridge view: ownership plus current membership. */
  readonly member: (before: unknown) => Promise<boolean>;
  readonly request: (before: unknown) => Record<string, unknown>;
  /** A fresh post-connect inspection of both views. */
  readonly confirm: () => Promise<boolean>;
  readonly failed: () => Error;
  readonly unconfirmed: string;
}

/** Shared platform and Document Server settlement: one deadline, definitive replies, fresh inspection. */
async function settleAttachment(
  raw: DockerClient,
  userId: string,
  captured: OwnedNetwork,
  prepare: (client: DockerClient) => Promise<AttachmentTarget | undefined>,
  current: () => void,
  verify: (() => Promise<void>) | undefined,
): Promise<void> {
  const signal = AbortSignal.timeout(ATTACH_TIMEOUT_MS);
  const client: DockerClient = {
    ...raw,
    json: (method, path, body, _signal, maxBytes) => raw.json(method, path, body, signal, maxBytes),
  };
  const target = await prepare(client);
  if (target === undefined) return;
  const before = await inspect(client, captured.id);
  const network = inspectedNetwork(before, userId, captured.id);
  if (network.subnet !== captured.subnet) throw new Error('Captured network subnet changed');
  let definitiveReply = false;
  if (!(await target.member(before))) {
    const request = target.request(before);
    await verify?.();
    current();
    // Do not drop submitted mutation ownership on abort or on a lost response.
    try {
      await client.json('POST', `/networks/${network.id}/connect`, request);
      definitiveReply = true;
    } catch (error) {
      // A transport/parsing/deadline failure cannot establish a definitive mutation result.
      // Still settle a lost response as success if independently inspected membership agrees.
      definitiveReply = error instanceof DockerHttpError;
    }
  }
  const attached = await target.confirm();
  current();
  if (attached) return;
  if (definitiveReply) throw target.failed();
  throw new Error(target.unconfirmed);
}

/** The caller supplies its independent bounded settlement client, never its cancellation signal. */
export async function attachPlatform(
  raw: DockerClient,
  transport: TransportContext,
  userId: string,
  container: string,
  captured: OwnedNetwork,
  documentServer: string | null,
  current: () => void = () => undefined,
  verify?: () => Promise<void>,
): Promise<void> {
  await settleAttachment(
    raw,
    userId,
    captured,
    async (client) => {
      const platform = await verifiedPlatform(client, transport, true);
      if (platform === undefined) return undefined;
      return {
        member: (before) => {
          ownedEndpoints(before, userId, container, platform, documentServer);
          return Promise.resolve(
            endpointMembership(platform, 'platform', before, userId, captured.subnet, false),
          );
        },
        request: (before) => connectRequest(before, container, platform.id, captured.subnet),
        confirm: () =>
          inspectPlatformAttachment(client, transport, userId, container, captured, documentServer),
        failed: () => new PlatformAttachmentFailedError(),
        unconfirmed: 'Platform attachment outcome unconfirmed',
      };
    },
    current,
    verify,
  );
}

/** Attach this start's verified Document Server at base+4, re-verified just before connect. */
export async function attachDocumentServer(
  raw: DockerClient,
  transport: TransportContext,
  userId: string,
  container: string,
  captured: OwnedNetwork,
  documentServer: string,
  verify: () => Promise<void>,
): Promise<void> {
  await settleAttachment(
    raw,
    userId,
    captured,
    async (client) => {
      // Only network mode records a Document Server, so the configured platform is present here.
      const platform = await verifiedPlatform(client, transport, true);
      return {
        member: (before) => {
          ownedEndpoints(before, userId, container, platform, documentServer);
          return recordedMembership(
            client,
            before,
            userId,
            captured.subnet,
            documentServer,
            'checked',
          );
        },
        request: () => ({
          Container: documentServer,
          EndpointConfig: {
            IPAMConfig: { IPv4Address: instanceAddressLayout(captured.subnet).documentServer },
          },
        }),
        confirm: () =>
          inspectAttachment(client, transport, userId, container, captured, documentServer, true),
        failed: () => new Error('Document Server attachment confirmed absent after connect'),
        unconfirmed: 'Document Server attachment outcome unconfirmed',
      };
    },
    () => undefined,
    verify,
  );
}
