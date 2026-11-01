import { isDeepStrictEqual } from 'node:util';
import type { PlatformConfig } from '../config.ts';
import type { DatabaseHandle } from '../db/index.ts';
import type { ManagedConfigInput } from '../managed-config/index.ts';
import type { PluginCatalog } from '../plugin-catalog/index.ts';
import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import {
  absentInstanceIdentity,
  containerId,
  isTerminalInstance,
  object,
  ownedContainer,
  resolvedImageId,
} from './identity.ts';
import type { AbsentInstanceIdentity } from './identity.ts';
import { attachedNetwork, validateUserNetwork } from './networks.ts';
import { upstreamHost, upstreamPort } from './transport.ts';
import type { TransportContext } from './transport.ts';
import { readCreationAttempt } from './creation-attempt.ts';

export interface StartUserContainerInput {
  readonly client: DockerClient;
  readonly database: DatabaseHandle;
  readonly transport: TransportContext;
  readonly config: Pick<
    PlatformConfig,
    'userImage' | 'seccompProfilePath' | 'managedConfigDir' | 'authority' | 'subnetPool'
  >;
  readonly userId: string;
  readonly modelSettings: Omit<ManagedConfigInput['modelSettings'], 'apiKeyConfigured'>;
  readonly modelKey?: string | undefined;
  readonly pluginCatalog: PluginCatalog;
  readonly signal?: AbortSignal;
  readonly onVerifiedAbsent?: (identity: AbsentInstanceIdentity) => void;
}

export type StartResult =
  | { outcome: 'unconfigured' | 'full' }
  | {
      outcome: 'starting' | 'running';
      containerId: string;
      upstreamHost: string;
      upstreamPort: number;
    };

export function inspectUserContainerState(
  document: unknown,
  id: string,
  name: string,
  userId: string,
  imageId: string,
): boolean {
  const row = ownedContainer(document, name, userId, imageId);
  const running = object(row.State).Running;
  if (row.Id !== id || typeof running !== 'boolean')
    throw new Error('Container identity or state mismatch');
  return running;
}
export function inspectUserContainerEndpoint(
  document: unknown,
  id: string,
  name: string,
  userId: string,
  imageId: string,
  mode: PlatformConfig['upstreamMode'],
): number {
  const row = ownedContainer(document, name, userId, imageId);
  if (row.Id !== id || object(row.State).Running !== true)
    throw new Error('Started container identity or state mismatch');
  attachedNetwork(row, userId);
  upstreamHost(row, userId, mode);
  return upstreamPort(row, mode);
}

export function assertCurrentSnapshot(
  input: Pick<StartUserContainerInput, 'database' | 'userId'>,
  account: Record<string, unknown>,
  instance: Record<string, unknown>,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  if (
    !isDeepStrictEqual(
      input.database.prepare('SELECT * FROM users WHERE id = ?').get(input.userId),
      account,
    ) ||
    !isDeepStrictEqual(
      input.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(input.userId),
      instance,
    )
  )
    throw new Error('Current startup identity changed');
}

function assertCurrentEndpoint(
  instance: Record<string, unknown>,
  host: string,
  port: number,
): void {
  if (
    instance.upstream_host !== host ||
    instance.upstream_port !== port ||
    typeof instance.last_started_at !== 'number' ||
    !Number.isSafeInteger(instance.last_started_at)
  )
    throw new Error('Current instance endpoint mismatch');
}

export async function reuseCurrentContainer(
  input: StartUserContainerInput,
  client: DockerClient,
  account: Record<string, unknown>,
  signal: AbortSignal,
  missing: () => void,
  retry: (instance: Record<string, unknown>) => void,
): Promise<StartResult | undefined> {
  if (readCreationAttempt(input) !== undefined) return undefined;
  const selected: unknown = input.database
    .prepare('SELECT * FROM instances WHERE user_id = ?')
    .get(input.userId);
  if (selected === undefined) return undefined;
  const instance = object(selected);
  if (isTerminalInstance(instance.status, instance.container_id)) return undefined;
  const id = containerId({ Id: instance.container_id });
  const image = resolvedImageId(instance.image_id);
  if (typeof instance.image_tag !== 'string' || instance.image_tag.length === 0)
    throw new Error('Invalid indexed image tag');
  let document: unknown;
  try {
    document = await client.json('GET', `/containers/${id}/json`);
  } catch (error) {
    if (!(error instanceof DockerHttpError) || error.statusCode !== 404) throw error;
    assertCurrentSnapshot(input, account, instance, signal);
    const identity = absentInstanceIdentity(instance, id);
    input.onVerifiedAbsent?.(identity);
    missing();
    return undefined;
  }
  if (instance.status === 'error') {
    assertCurrentSnapshot(input, account, instance, signal);
    retry(instance);
    return undefined;
  }
  if (instance.status !== 'starting' && instance.status !== 'running')
    throw new Error('Current instance is not reusable');
  const port = inspectUserContainerEndpoint(
    document,
    id,
    `dsh-team-u-${input.userId}`,
    input.userId,
    image,
    input.transport.config.upstreamMode,
  );
  await validateUserNetwork(client, input.userId, document, input.transport);
  const host = upstreamHost(document, input.userId, input.transport.config.upstreamMode);
  assertCurrentEndpoint(instance, host, port);
  assertCurrentSnapshot(input, account, instance, signal);
  return {
    outcome: instance.status,
    containerId: id,
    upstreamHost: host,
    upstreamPort: port,
  };
}

export async function retireCurrentErrorContainer(
  input: StartUserContainerInput,
  account: Record<string, unknown>,
  instance: Record<string, unknown>,
  signal: AbortSignal,
  retire: (signal: AbortSignal, assertCurrent: () => void) => Promise<boolean>,
): Promise<void> {
  // Canonical retirement owns cancellation and bounded post-removal network settlement.
  const identitySignal = new AbortController().signal;
  if (
    !(await retire(signal, () => {
      assertCurrentSnapshot(input, account, instance, identitySignal);
    }))
  )
    throw new Error('Retained error container was not retired');
  assertCurrentSnapshot(
    input,
    account,
    {
      ...instance,
      status: 'stopped',
      container_id: null,
      image_id: null,
      image_tag: null,
      upstream_host: null,
      upstream_port: null,
      dsh_cookie: null,
      instance_token_hash: null,
    },
    signal,
  );
}
