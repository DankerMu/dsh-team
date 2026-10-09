import { createHash } from 'node:crypto';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { DatabaseHandle } from '../db/index.ts';
import type { DockerClient } from './client.ts';
import { inspectUserContainerEndpoint } from './start.ts';
import { object, resolvedImageId } from './identity.ts';
import { extractLaunchToken } from './web-launch-token.ts';
import { isIPv4 } from 'node:net';
import { upstreamHost } from './transport.ts';
import type { TransportContext } from './transport.ts';
import { validateUserNetwork } from './networks.ts';

export interface AcquireDshCookieInput {
  readonly client: DockerClient;
  readonly database: DatabaseHandle;
  readonly transport: TransportContext;
  readonly userId: string;
  readonly authority: string;
  readonly signal?: AbortSignal;
}
export interface IndexedInstance {
  container_id: string;
  upstream_host: string | null;
  upstream_port: number | null;
  image_tag: string;
  image_id: string;
  last_started_at: number | null;
}
interface Instance extends IndexedInstance {
  upstream_host: string;
  upstream_port: number;
  last_started_at: number;
}

// A silent Web process or hostile log/header must not retain an acquisition indefinitely.
const ACQUISITION_TIMEOUT_MS = 60_000;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_COOKIE_BYTES = 4 * 1024;
export const CURRENT_INSTANCE = `user_id = ? AND container_id = ? AND upstream_host IS ?
  AND upstream_port IS ? AND image_tag = ? AND image_id = ? AND last_started_at IS ? AND status = 'starting'
  AND EXISTS (SELECT 1 FROM users WHERE id = instances.user_id AND status = 'active')`;

function indexedHost(
  host: unknown,
  allowIncomplete: boolean,
  mode: TransportContext['config']['upstreamMode'],
): string | null {
  if (allowIncomplete && host === null) return null;
  if (typeof host !== 'string' || (mode === 'network' ? !isIPv4(host) : host !== '127.0.0.1'))
    throw new Error();
  return host;
}

function indexedPort(
  port: unknown,
  allowIncomplete: boolean,
  mode: TransportContext['config']['upstreamMode'],
): number | null {
  if (allowIncomplete && port === null) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error();
  if (mode === 'network' && port !== 3080) throw new Error();
  return port;
}
export function indexedEndpoint(
  instance: Record<string, unknown>,
  allowIncomplete: boolean,
  mode: TransportContext['config']['upstreamMode'],
): Pick<IndexedInstance, 'upstream_host' | 'upstream_port' | 'last_started_at'> {
  const started = instance.last_started_at;
  if (!(allowIncomplete && started === null)) {
    if (typeof started !== 'number' || !Number.isSafeInteger(started)) throw new Error();
  }
  return {
    upstream_host: indexedHost(instance.upstream_host, allowIncomplete, mode),
    upstream_port: indexedPort(instance.upstream_port, allowIncomplete, mode),
    last_started_at: started,
  };
}

export function currentInstance(input: AcquireDshCookieInput): Instance;
export function currentInstance(
  input: AcquireDshCookieInput,
  allowIncomplete: true,
): IndexedInstance;
export function currentInstance(
  input: AcquireDshCookieInput,
  allowIncomplete = false,
): IndexedInstance {
  if (!/^[a-z0-9]{12}$/.test(input.userId)) throw new Error();
  const row: unknown = input.database
    .prepare(
      `SELECT instances.* FROM instances
    JOIN users ON users.id = instances.user_id
    WHERE user_id = ? AND users.status = 'active' AND instances.status = 'starting'`,
    )
    .get(input.userId);
  if (typeof row !== 'object' || row === null) throw new Error();
  // SQLite values cross a boundary; validate every consumed field before use.
  const instance = row as Record<string, unknown>;
  if (
    typeof instance.container_id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(instance.container_id) ||
    typeof instance.image_tag !== 'string' ||
    instance.image_tag.length === 0
  )
    throw new Error();
  return {
    container_id: instance.container_id,
    ...indexedEndpoint(instance, allowIncomplete, input.transport.config.upstreamMode),
    image_tag: instance.image_tag,
    image_id: resolvedImageId(instance.image_id),
  };
}

async function launchToken(client: DockerClient, id: string, signal: AbortSignal): Promise<string> {
  // Fixed storage avoids repeatedly copying a growing partial line. Parse only complete stdout lines.
  const line = Buffer.alloc(MAX_LINE_BYTES);
  let used = 0;
  for await (const chunk of client.logs(
    `/containers/${id}/logs?stdout=true&stderr=true&follow=true`,
    signal,
  )) {
    signal.throwIfAborted();
    if (chunk.stream !== 'stdout') continue;
    let offset = 0;
    while (offset < chunk.data.length) {
      const newline = chunk.data.indexOf(10, offset);
      const end = newline === -1 ? chunk.data.length : newline + 1;
      const length = end - offset;
      if (used + length > MAX_LINE_BYTES) throw new Error();
      chunk.data.copy(line, used, offset, end);
      used += length;
      offset = end;
      if (newline === -1) continue;
      const token = extractLaunchToken(line.toString('utf8', 0, used));
      used = 0;
      if (token !== undefined) return token;
    }
  }
  // A stream ending with a token-like prefix is not a complete released launch announcement.
  throw new Error();
}

function canonicalBytes(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error();
  return bytes;
}
function validateCookiePayload(payload: unknown, authority: string): number {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('version' in payload) ||
    payload.version !== 1 ||
    !('authority' in payload) ||
    payload.authority !== authority ||
    !('issuedAt' in payload) ||
    typeof payload.issuedAt !== 'number' ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !('expiresAt' in payload) ||
    typeof payload.expiresAt !== 'number' ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= payload.issuedAt
  )
    throw new Error();
  return payload.expiresAt;
}

export function dshCookieExpiresAt(cookie: string, authority?: string): number {
  // Released client-connection 0.2.0-rc.2: authority SHA256 name and v1.JSON.HMAC-SHA256 value.
  if (cookie.length > MAX_COOKIE_BYTES) throw new Error();
  const separator = cookie.indexOf('=');
  const parts = cookie.slice(separator + 1).split('.');
  const [version, body, signature] = parts;
  if (
    separator < 0 ||
    parts.length !== 3 ||
    version !== 'v1' ||
    body === undefined ||
    signature === undefined ||
    canonicalBytes(signature).length !== 32
  )
    throw new Error();
  const payload = object(JSON.parse(canonicalBytes(body).toString('utf8')));
  if (typeof payload.authority !== 'string') throw new Error();
  const audience = authority ?? payload.authority;
  if (new URL(`http://${audience}`).host === '' || /[\s/@?#\\]/.test(audience)) throw new Error();
  const name = `dsh-auth-${createHash('sha256').update(audience).digest('base64url')}`;
  if (cookie.slice(0, separator) !== name) throw new Error();
  return validateCookiePayload(payload, audience);
}

function authenticationCookie(headers: string[] | undefined, authority: string): string {
  const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`;
  const cookies = headers
    ?.map((header) => header.split(';')[0] ?? '')
    .filter((pair) => pair.startsWith(`${name}=`));
  if (cookies?.length !== 1) throw new Error();
  const cookie = cookies[0];
  if (cookie === undefined) throw new Error();
  if (dshCookieExpiresAt(cookie, authority) <= Date.now()) throw new Error();
  return cookie;
}

async function exchange(
  host: string,
  port: number,
  authority: string,
  token: string,
  signal: AbortSignal,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let incoming: IncomingMessage | undefined;
  const outgoing = request(
    {
      hostname: host,
      port,
      method: 'GET',
      path: `/?token=${encodeURIComponent(token)}`,
      headers: { Host: authority },
      signal,
      maxHeaderSize: MAX_HEADER_BYTES,
    },
    (response) => {
      incoming = response;
      try {
        signal.throwIfAborted();
        if (response.statusCode !== 303) throw new Error();
        resolve(
          authenticationCookie(response.headers['set-cookie'], new URL(`http://${authority}`).host),
        );
      } catch {
        reject(new Error());
      } finally {
        response.destroy();
      }
    },
  );
  outgoing.on('error', () => {
    reject(new Error());
  });
  try {
    outgoing.end();
    return await promise;
  } finally {
    incoming?.destroy();
    outgoing.destroy();
  }
}

/** Internal sibling contract: returns exactly the credential this acquisition committed. */
export async function acquireCurrentDshCookie(input: AcquireDshCookieInput): Promise<string> {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, ACQUISITION_TIMEOUT_MS);
  const signal =
    input.signal === undefined ? deadline.signal : AbortSignal.any([input.signal, deadline.signal]);
  let stage = 'current instance';
  try {
    const instance = currentInstance(input);
    const identity = [
      input.userId,
      instance.container_id,
      instance.upstream_host,
      instance.upstream_port,
      instance.image_tag,
      instance.image_id,
      instance.last_started_at,
    ];
    // Clear before any asynchronous credential work, including failed inspection/reacquisition.
    const cleared = input.database
      .prepare(`UPDATE instances SET dsh_cookie = NULL WHERE ${CURRENT_INSTANCE}`)
      .run(...identity);
    if (cleared.changes !== 1) throw new Error();
    stage = 'authority';
    const authority = input.authority;
    if (new URL(`http://${authority}`).host === '' || /[\s/@?#\\]/.test(authority))
      throw new Error();
    signal.throwIfAborted();
    stage = 'owned container';
    const document = await input.client.json(
      'GET',
      `/containers/${instance.container_id}/json`,
      undefined,
      signal,
    );
    const port = inspectUserContainerEndpoint(
      document,
      instance.container_id,
      `dsh-team-u-${input.userId}`,
      input.userId,
      instance.image_id,
      input.transport.config.upstreamMode,
    );
    const client: DockerClient = {
      ...input.client,
      json: (method, path, body, _signal, maxBytes) =>
        input.client.json(method, path, body, signal, maxBytes),
    };
    await validateUserNetwork(client, input.userId, document, input.transport);
    const host = upstreamHost(document, input.userId, input.transport.config.upstreamMode);
    if (port !== instance.upstream_port || host !== instance.upstream_host) throw new Error();
    if (
      input.database
        .prepare(`SELECT 1 FROM instances WHERE ${CURRENT_INSTANCE} AND dsh_cookie IS NULL`)
        .get(...identity) === undefined
    )
      throw new Error();
    stage = 'launch announcement';
    const token = await launchToken(input.client, instance.container_id, signal);
    stage = 'HTTP exchange';
    const cookie = await exchange(host, port, authority, token, signal);
    stage = 'current instance persistence';
    signal.throwIfAborted();
    const stored = input.database
      .prepare(
        `UPDATE instances SET dsh_cookie = ? WHERE ${CURRENT_INSTANCE} AND dsh_cookie IS NULL`,
      )
      .run(cookie, ...identity);
    if (stored.changes !== 1) throw new Error();
    return cookie;
  } catch {
    // Never retain upstream error messages, causes, URLs, response headers or log bytes.
    throw new Error(`DSH credential acquisition failed during ${stage}`);
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}

/** Acquire only; startup and readiness remain separate operations. No secret is returned. */
export async function acquireDshCookie(input: AcquireDshCookieInput): Promise<void> {
  await acquireCurrentDshCookie(input);
}
