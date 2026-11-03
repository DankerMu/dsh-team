import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseAddress } from '../auth/index.ts';
import type { PlatformConfig } from '../config.ts';
import type { DatabaseHandle } from '../db/index.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The owner of the authenticated instance on the RAGFlow proxy prefix; otherwise undefined. */
    instanceUserId: string | undefined;
  }
}

const PREFIX = '/_platform/instance-api/ragflow/';
// The orchestrator issues 32 random bytes as lowercase hex; nothing else is ever a token.
const BEARER = /^Bearer ([0-9a-f]{64})$/;
const SELECT_INSTANCE = `SELECT instances.user_id, instances.upstream_host FROM instances
  JOIN users ON users.id = instances.user_id
  WHERE instances.instance_token_hash = ? AND instances.status = 'running'
    AND users.status = 'active'`;
/** Fixed bodies: every rejection reason shares the one 401. */
export const INSTANCE_ERRORS = {
  401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
  500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
} as const;

interface InstanceRow {
  readonly user_id: string;
  readonly upstream_host: string | null;
}
interface InstancePeer {
  readonly headers: { readonly authorization?: string | undefined };
  readonly socket: { readonly remoteAddress?: string | undefined };
}

/**
 * The owner of the running instance whose token this is, when the request comes from that
 * instance's own address; otherwise null. The socket peer is authoritative: an instance reaches
 * the platform directly, so forwarding headers are never trusted here. A malformed token or peer
 * never reaches the token store; a store failure escapes so it is not mistaken for a bad token.
 */
export function authenticateInstance(
  request: InstancePeer,
  lookup: (tokenHash: string) => InstanceRow | undefined,
): string | null {
  const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
  const remote = request.socket.remoteAddress;
  const source = remote === undefined ? undefined : parseAddress(remote);
  if (token === undefined || source === undefined) return null;
  const row = lookup(createHash('sha256').update(token).digest('hex'));
  return row?.upstream_host === source ? row.user_id : null;
}

/** Either the matched route or the query-stripped raw path lies under the proxy prefix. */
function underPrefix(request: FastifyRequest): boolean {
  // The router decodes unreserved escapes, so a declared route can match an encoded raw path.
  if (request.routeOptions.url?.startsWith(PREFIX) === true) return true;
  return request.url.split('?', 1)[0]?.startsWith(PREFIX) === true;
}

/**
 * Installs instance-token authentication for the whole RAGFlow proxy prefix on the root app,
 * before route plugins. Only network mode has instance addresses to check against.
 */
export function installInstanceAuth(
  app: FastifyInstance,
  database: DatabaseHandle,
  upstreamMode: PlatformConfig['upstreamMode'],
): void {
  app.decorateRequest('instanceUserId', undefined);
  app.addHook('onRequest', (request, reply, done) => {
    if (!underPrefix(request)) {
      done();
      return;
    }
    let owner: string | null = null;
    try {
      if (upstreamMode === 'network')
        owner = authenticateInstance(request.raw, (tokenHash) =>
          database.prepare<[string], InstanceRow>(SELECT_INSTANCE).get(tokenHash),
        );
    } catch {
      // Storage text can name tables; a failure is not reported as a rejected token.
      app.log.error('RAGFlow proxy authentication storage failure');
      void reply.code(500).send(INSTANCE_ERRORS[500]);
      return;
    }
    if (owner === null) {
      void reply.code(401).send(INSTANCE_ERRORS[401]);
      return;
    }
    request.instanceUserId = owner;
    done();
  });
}
