import { createHash } from 'node:crypto';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { DatabaseHandle } from '../db/index.ts';
import type { DockerClient } from './client.ts';
import { inspectUserContainerEndpoint, resolvedImageId } from './start.ts';
import { extractLaunchToken } from './web-launch-token.ts';

export interface AcquireDshCookieInput {
  readonly client: DockerClient;
  readonly database: DatabaseHandle;
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

function indexedEndpoint(
  instance: Record<string, unknown>,
  allowIncomplete: boolean,
): Pick<IndexedInstance, 'upstream_host' | 'upstream_port' | 'last_started_at'> {
  const host = instance.upstream_host;
  const port = instance.upstream_port;
  const started = instance.last_started_at;
  if (host !== '127.0.0.1' && !(allowIncomplete && host === null)) throw new Error();
  if (!(allowIncomplete && port === null)) {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error();
  }
  if (!(allowIncomplete && started === null)) {
    if (typeof started !== 'number' || !Number.isSafeInteger(started)) throw new Error();
  }
  return {
    upstream_host: host,
    upstream_port: port,
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
    ...indexedEndpoint(instance, allowIncomplete),
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
function validateCookiePayload(payload: unknown, authority: string): void {
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
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt <= Date.now()
  )
    throw new Error();
}

function authenticationCookie(headers: string[] | undefined, authority: string): string {
  // Released client-connection 0.2.0-rc.2: authority SHA256 name and v1.JSON.HMAC-SHA256 value.
  const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`;
  const cookies = headers
    ?.map((header) => header.split(';')[0] ?? '')
    .filter((pair) => pair.startsWith(`${name}=`));
  if (cookies?.length !== 1) throw new Error();
  const cookie = cookies[0];
  if (cookie === undefined || cookie.length > MAX_COOKIE_BYTES) throw new Error();
  const parts = cookie.slice(name.length + 1).split('.');
  const [version, body, signature] = parts;
  if (
    parts.length !== 3 ||
    version !== 'v1' ||
    body === undefined ||
    signature === undefined ||
    canonicalBytes(signature).length !== 32
  )
    throw new Error();
  const payload: unknown = JSON.parse(canonicalBytes(body).toString('utf8'));
  validateCookiePayload(payload, authority);
  return cookie;
}

async function exchange(
  port: number,
  authority: string,
  token: string,
  signal: AbortSignal,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let incoming: IncomingMessage | undefined;
  const outgoing = request(
    {
      hostname: '127.0.0.1',
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
    const port = inspectUserContainerEndpoint(
      await input.client.json(
        'GET',
        `/containers/${instance.container_id}/json`,
        undefined,
        signal,
      ),
      instance.container_id,
      `dsh-team-u-${input.userId}`,
      input.userId,
      instance.image_id,
    );
    if (port !== instance.upstream_port) throw new Error();
    if (
      input.database
        .prepare(`SELECT 1 FROM instances WHERE ${CURRENT_INSTANCE} AND dsh_cookie IS NULL`)
        .get(...identity) === undefined
    )
      throw new Error();
    stage = 'launch announcement';
    const token = await launchToken(input.client, instance.container_id, signal);
    stage = 'HTTP exchange';
    const cookie = await exchange(port, authority, token, signal);
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
