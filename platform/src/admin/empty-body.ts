import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

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
