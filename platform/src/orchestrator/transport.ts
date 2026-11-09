import { isIPv4 } from 'node:net';
import type { PlatformConfig } from '../config.ts';
import type { DockerClient } from './client.ts';
import { containerId, object } from './identity.ts';
import { instanceAddressLayout } from './subnet.ts';

export type TransportConfig = Pick<
  PlatformConfig,
  'upstreamMode' | 'platformContainerName' | 'instanceFontsDir'
>;
export interface TransportContext {
  readonly config: TransportConfig;
  platformId: string | undefined;
}
export interface PlatformEndpoint {
  readonly id: string;
  readonly name: string;
  readonly document: Record<string, unknown>;
}

/** The configured name identifies one immutable platform container for this owner's lifetime. */
export async function verifiedPlatform(
  client: DockerClient,
  transport: TransportContext,
  requireRunning: boolean,
): Promise<PlatformEndpoint | undefined> {
  if (transport.config.upstreamMode === 'published-loopback') return undefined;
  const name = transport.config.platformContainerName;
  const named = object(await client.json('GET', `/containers/${encodeURIComponent(name)}/json`));
  const id = containerId(named);
  if (named.Name !== `/${name}`) throw new Error('Configured platform name mismatch');
  const document = object(await client.json('GET', `/containers/${id}/json`));
  if (
    containerId(document) !== id ||
    document.Name !== `/${name}` ||
    (requireRunning && object(document.State).Running !== true) ||
    (transport.platformId !== undefined && transport.platformId !== id)
  )
    throw new Error('Configured platform identity changed or unavailable');
  transport.platformId = id;
  return { id, name, document };
}

/** The configured platform asks for base+3; the recorded Document Server for base+4. */
type PeerRole = 'platform' | 'documentServer';
const PEER = {
  platform: { label: 'Configured platform', layout: 'Platform' },
  documentServer: { label: 'Recorded Document Server', layout: 'Document Server' },
} as const;

/** Require agreement between independently inspected peer container and bridge endpoint views. */
export function endpointMembership(
  peer: PlatformEndpoint,
  role: PeerRole,
  network: unknown,
  userId: string,
  subnet: string,
  required: boolean,
  declaration: 'checked' | 'ignored' = 'checked',
): boolean {
  const bridge = object(network);
  const endpoint = object(bridge.Containers)[peer.id];
  const attachment = object(object(peer.document.NetworkSettings).Networks)[
    `dsh-team-net-${userId}`
  ];
  if (endpoint === undefined && attachment === undefined) {
    if (required) throw new Error(`${PEER[role].label} endpoint missing`);
    return false;
  }
  const connected = object(attachment);
  if (
    role === 'documentServer' &&
    endpoint === undefined &&
    connected.NetworkID === bridge.Id &&
    releasedEndpoint(peer.document, connected)
  )
    return true;
  const inspected = object(endpoint);
  if (connected.NetworkID !== bridge.Id || inspected.Name !== peer.name)
    throw new Error(`${PEER[role].label} endpoint mismatch`);
  containerId({ Id: connected.EndpointID });
  requireLayoutAddress(
    role,
    validateEndpointAddress(connected, inspected, subnet, declaration),
    declaration,
    subnet,
  );
  return true;
}

/**
 * Docker releases the endpoint of a stopped container, or one in restart-policy backoff (still
 * `Running`), but keeps its configuration with a cleared endpoint ID, re-attaching on start.
 */
function releasedEndpoint(
  document: Record<string, unknown>,
  attachment: Record<string, unknown>,
): boolean {
  const state = object(document.State);
  return (
    (state.Running === false || state.Restarting === true) &&
    (attachment.EndpointID === undefined || attachment.EndpointID === '')
  );
}

/** Only the platform has an undeclared stage-1 form; a Document Server is always on the layout. */
function requireLayoutAddress(
  role: PeerRole,
  declared: string | undefined,
  declaration: 'checked' | 'ignored',
  subnet: string,
): void {
  const undeclared = role === 'documentServer' && declaration === 'checked';
  if (
    (declared === undefined && undeclared) ||
    (declared !== undefined && declared !== instanceAddressLayout(subnet)[role])
  )
    throw new Error(`${PEER[role].layout} endpoint address differs from its layout`);
}

/** Docker reports null for an endpoint attached without a requested address; `{}` is treated alike. */
function declaredAddress(attachment: Record<string, unknown>): string | undefined {
  if (attachment.IPAMConfig === undefined || attachment.IPAMConfig === null) return undefined;
  const config = object(attachment.IPAMConfig);
  if (Object.keys(config).length === 0) return undefined;
  const declared = config.IPv4Address;
  if (typeof declared !== 'string' || !isIPv4(declared))
    throw new Error('Invalid endpoint address declaration');
  return declared;
}

/** A requested address must be the actual address in both inspect views, whatever the endpoint role. */
function validateDeclaredAddress(
  attachment: Record<string, unknown>,
  endpoint: Record<string, unknown>,
): string | undefined {
  const declared = declaredAddress(attachment);
  if (
    declared !== undefined &&
    (attachment.IPAddress !== declared || endpoint.IPv4Address !== `${declared}/28`)
  )
    throw new Error('Endpoint address differs from its declaration');
  return declared;
}

/** Returns the verified declared address, if any, so a caller can add its role's layout check. */
export function validateEndpointAddress(
  attachment: Record<string, unknown>,
  endpoint: Record<string, unknown>,
  subnet: string,
  declaration: 'checked' | 'ignored' = 'checked',
): string | undefined {
  const address = attachment.IPAddress;
  const base = subnet.slice(0, -3);
  const lastDot = base.lastIndexOf('.');
  const prefix = base.slice(0, lastDot + 1);
  if (typeof address !== 'string' || !address.startsWith(prefix))
    throw new Error('Endpoint subnet mismatch');
  const host = Number(address.slice(prefix.length));
  const start = Number(base.slice(lastDot + 1));
  if (
    !Number.isInteger(host) ||
    host <= start ||
    host >= start + 15 ||
    address !== `${prefix}${String(host)}` ||
    endpoint.IPv4Address !== `${address}/28` ||
    endpoint.EndpointID !== attachment.EndpointID
  )
    throw new Error('Endpoint address mismatch');
  return declaration === 'checked' ? validateDeclaredAddress(attachment, endpoint) : undefined;
}

/** The container's own address on its instance bridge, in either transport mode. */
export function instanceBridgeAddress(document: unknown, userId: string): string {
  const networks = object(object(object(document).NetworkSettings).Networks);
  const host = object(networks[`dsh-team-net-${userId}`]).IPAddress;
  if (typeof host !== 'string' || !isIPv4(host)) throw new Error('Invalid instance IPv4 endpoint');
  return host;
}

export function upstreamHost(
  document: unknown,
  userId: string,
  mode: PlatformConfig['upstreamMode'],
): string {
  return mode === 'published-loopback' ? '127.0.0.1' : instanceBridgeAddress(document, userId);
}

export function upstreamPort(document: unknown, mode: PlatformConfig['upstreamMode']): number {
  if (mode === 'network') {
    requireUnpublished(document, mode);
    return 3080;
  }
  const ports = object(object(object(document).NetworkSettings).Ports);
  const bindings: unknown = ports['3080/tcp'];
  if (Object.keys(ports).length !== 1 || !Array.isArray(bindings) || bindings.length !== 1)
    throw new Error('Invalid Docker loopback publication');
  const binding = object(bindings[0]);
  const port = binding.HostPort;
  if (
    binding.HostIp !== '127.0.0.1' ||
    typeof port !== 'string' ||
    !/^[1-9][0-9]{0,4}$/.test(port) ||
    Number(port) > 65535
  )
    throw new Error('Invalid Docker loopback endpoint');
  return Number(port);
}

/** Exposed container ports are not publications; every host binding or publish-all is forbidden. */
export function requireUnpublished(document: unknown, mode: PlatformConfig['upstreamMode']): void {
  if (mode === 'published-loopback') return;
  const row = object(document);
  const host = object(row.HostConfig);
  if (host.PublishAllPorts === true) throw new Error('Unexpected publish-all behavior');
  if (host.PortBindings !== undefined && host.PortBindings !== null) {
    if (Object.keys(object(host.PortBindings)).length !== 0)
      throw new Error('Unexpected host port bindings');
  }
  const ports = object(object(row.NetworkSettings).Ports);
  if (Object.values(ports).some((bindings) => bindings !== null))
    throw new Error('Unexpected instance publication');
}
