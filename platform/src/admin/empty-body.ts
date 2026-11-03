import type {
  FastifyBaseLogger,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import { getSessionUser, readSessionCookie } from '../auth/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { withRequestAbort } from '../request-abort.ts';

interface AdminError {
  readonly statusCode: number;
  readonly error: string;
  readonly message: string;
}
/** Fixed bodies shared by administrator mutations; never carry request-derived text. */
export const ADMIN_ERRORS = {
  401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
  403: { statusCode: 403, error: 'Forbidden', message: 'Forbidden' },
  413: { statusCode: 413, error: 'Payload Too Large', message: 'Request body too large' },
  415: { statusCode: 415, error: 'Unsupported Media Type', message: 'JSON request body required' },
  500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
} as const;
export const EMPTY_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const;

/** Current authority after the body is read; entry admission alone is not enough. */
export function authorityRejection(
  database: DatabaseHandle,
  request: Pick<FastifyRequest, 'headers'>,
): AdminError | null {
  const token = readSessionCookie(request.headers.cookie);
  const actor = token === null ? null : getSessionUser(database, token, Date.now(), false);
  if (actor === null) return ADMIN_ERRORS[401];
  return actor.role === 'admin' ? null : ADMIN_ERRORS[403];
}

/** What one administrator connection-test route supplies to the shared runner. */
interface ConnectionTestRoute {
  readonly database: DatabaseHandle;
  /** Aborted by the application before it drains in-flight responses. */
  readonly shutdown: AbortSignal;
  readonly log: FastifyBaseLogger;
  /** Fixed warning text for a non-ok outcome. */
  readonly failed: string;
  /** Logs the route's fixed failure text and returns its fixed 500 body. */
  readonly failure: () => AdminError;
}

/**
 * Runs one connection test after the body is read: current authority is rechecked first, and
 * the test's signal aborts when the client disconnects or the application shuts down.
 */
export async function runConnectionTest<Outcome extends { readonly result: string }>(
  route: ConnectionTestRoute,
  request: FastifyRequest,
  reply: FastifyReply,
  test: (signal: AbortSignal) => Promise<Outcome>,
): Promise<Outcome | FastifyReply> {
  try {
    return await withRequestAbort(reply, route.shutdown, async (signal) => {
      const rejection = authorityRejection(route.database, request);
      if (rejection !== null) return await reply.code(rejection.statusCode).send(rejection);
      const outcome = await test(signal);
      // Fixed text and the closed-set code only: errors, addresses and upstream bodies stay out.
      if (outcome.result !== 'ok') route.log.warn({ result: outcome.result }, route.failed);
      return outcome;
    });
  } catch {
    return await reply.code(500).send(route.failure());
  }
}

/** Exact `{}` body admission and its 400/413/415 transport mapping for one route family. */
export function emptyBodyPolicy(message: string) {
  const invalid = { statusCode: 400, error: 'Bad Request', message } as const;
  function transportError(error: unknown): AdminError | undefined {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (status === 400) return invalid;
    if (status === 413 || status === 415) return ADMIN_ERRORS[status];
    return undefined;
  }
  return {
    invalid,
    // The schema documents the contract; preValidation owns the exact empty-object check.
    validatorCompiler: () => (value: unknown) => ({ value }),
    preValidation: (
      request: FastifyRequest,
      reply: FastifyReply,
      next: HookHandlerDoneFunction,
    ): void => {
      const body: unknown = request.body;
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      ) {
        void reply.code(400).send(invalid);
        return;
      }
      next();
    },
    transportError,
    /** Route error handler: transport rejections map here; everything else goes to `failure`. */
    errorHandler(failure: (error: unknown) => AdminError) {
      return (error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
        const response = transportError(error) ?? failure(error);
        return reply.code(response.statusCode).send(response);
      };
    },
  };
}
