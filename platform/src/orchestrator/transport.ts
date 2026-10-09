import { isIPv4 } from 'node:net';
import type { PlatformConfig } from '../config.ts';
import type { DockerClient } from './client.ts';
import { containerId, object } from './identity.ts';

export type TransportConfig = Pick<PlatformConfig, 'upstreamMode' | 'platformContainerName'>;
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

/** Require agreement between independently inspected container and bridge endpoint views. */
export function platformMembership(
  platform: PlatformEndpoint,
  network: unknown,
  userId: string,
  subnet: string,
  required: boolean,
): boolean {
  const bridge = object(network);
  const endpoint = object(bridge.Containers)[platform.id];
  const attachment = object(object(platform.document.NetworkSettings).Networks)[
    `dsh-team-net-${userId}`
  ];
  if (endpoint === undefined && attachment === undefined) {
    if (required) throw new Error('Configured platform endpoint missing');
    return false;
  }
  const connected = object(attachment);
  const inspected = object(endpoint);
  if (connected.NetworkID !== bridge.Id || inspected.Name !== platform.name)
    throw new Error('Configured platform endpoint mismatch');
  containerId({ Id: connected.EndpointID });
  validateEndpointAddress(connected, inspected, subnet);
  return true;
}

export function validateEndpointAddress(
  attachment: Record<string, unknown>,
  endpoint: Record<string, unknown>,
  subnet: string,
): void {
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
}

export function upstreamHost(
  document: unknown,
  userId: string,
  mode: PlatformConfig['upstreamMode'],
): string {
  if (mode === 'published-loopback') return '127.0.0.1';
  const networks = object(object(object(document).NetworkSettings).Networks);
  const host = object(networks[`dsh-team-net-${userId}`]).IPAddress;
  if (typeof host !== 'string' || !isIPv4(host)) throw new Error('Invalid instance IPv4 endpoint');
  return host;
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
