import type { PlatformConfig } from '../config.ts';
import { documentServerMode } from '../db/index.ts';
import type { Settings } from '../db/index.ts';
import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { containerId, object } from './identity.ts';
import type { PlatformEndpoint } from './transport.ts';

/** This start's Document Server decision; persisted with the row, never cached on the owner. */
export interface DocumentServerDecision {
  readonly mode: 'bundled' | 'external' | 'unconfigured';
  readonly containerId: string | null;
  readonly reason: 'absent' | 'identity-mismatch' | null;
}

const CONTAINER_ID = /^[a-f0-9]{64}$/;

/** The recorded attachment identity of an `instances` row; anything else fails closed. */
export function recordedDocumentServer(row: unknown): string | null {
  if (row === undefined) return null;
  const recorded = object(row).document_server_container_id;
  if (recorded === null) return null;
  if (typeof recorded !== 'string' || !CONTAINER_ID.test(recorded))
    throw new Error('Invalid recorded Document Server identity');
  return recorded;
}

/** Same ID, configured name and running; an exact-ID 404 is a changed identity, not a Docker error. */
async function isDocumentServer(client: DockerClient, id: string, name: string): Promise<boolean> {
  let document: Record<string, unknown>;
  try {
    document = object(await client.json('GET', `/containers/${id}/json`));
  } catch (error) {
    if (error instanceof DockerHttpError && error.statusCode === 404) return false;
    throw error;
  }
  return (
    document.Id === id && document.Name === `/${name}` && object(document.State).Running === true
  );
}

/** The pre-connect re-verification: any change now fails the start instead of degrading it. */
export async function verifyDocumentServer(
  client: DockerClient,
  id: string,
  configured: PlatformConfig['documentServer'],
): Promise<void> {
  if (configured === null || !(await isDocumentServer(client, id, configured.containerName)))
    throw new Error('Document Server identity changed before attachment');
}

/** Resolve the configured name afresh before the overlay; unavailability never blocks a start. */
export async function documentServerDecision(
  client: DockerClient,
  settings: Settings,
  configured: PlatformConfig['documentServer'],
  upstreamMode: PlatformConfig['upstreamMode'],
): Promise<DocumentServerDecision> {
  if (documentServerMode(settings) === 'external')
    return { mode: 'external', containerId: null, reason: null };
  if (configured === null) return { mode: 'unconfigured', containerId: null, reason: null };
  // Published-loopback has no instance bridge peer; the mode is still recorded.
  if (upstreamMode !== 'network') return { mode: 'bundled', containerId: null, reason: null };
  const name = configured.containerName;
  let named: Record<string, unknown>;
  try {
    named = object(await client.json('GET', `/containers/${encodeURIComponent(name)}/json`));
  } catch (error) {
    // Only the name lookup's 404 means absent; any other Docker answer is a startup failure.
    if (error instanceof DockerHttpError && error.statusCode === 404)
      return { mode: 'bundled', containerId: null, reason: 'absent' };
    throw error;
  }
  const id = named.Id;
  if (
    typeof id !== 'string' ||
    !CONTAINER_ID.test(id) ||
    !(await isDocumentServer(client, id, name))
  )
    return { mode: 'bundled', containerId: null, reason: 'identity-mismatch' };
  return { mode: 'bundled', containerId: id, reason: null };
}

/** The recorded peer, named by its own document; a gone container is acceptable only off the bridge. */
export async function documentServerPeer(
  client: DockerClient,
  id: string,
  network: unknown,
): Promise<PlatformEndpoint | undefined> {
  let document: Record<string, unknown>;
  try {
    document = object(await client.json('GET', `/containers/${id}/json`));
  } catch (error) {
    if (!(error instanceof DockerHttpError) || error.statusCode !== 404) throw error;
    if (id in object(object(network).Containers))
      throw new Error('Recorded Document Server endpoint lost its container', { cause: error });
    return undefined;
  }
  const name = document.Name;
  if (containerId(document) !== id || typeof name !== 'string' || !name.startsWith('/'))
    throw new Error('Recorded Document Server identity changed');
  return { id, name: name.slice(1), document };
}
