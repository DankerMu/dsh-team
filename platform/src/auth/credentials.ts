import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { normalizeEmail } from './identity.ts';

const INVALID_EMAIL = 'Invalid email';

export const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['statusCode', 'error', 'message'],
  additionalProperties: false,
  properties: {
    statusCode: { type: 'number' },
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rejectInvalidBody(reply: FastifyReply, message: string): void {
  void reply.code(400).send({ statusCode: 400, error: 'Bad Request', message });
}

export function rejectInvalidCredentialBody(
  invalidBodyMessage: string,
): (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => void {
  return (request, reply, done) => {
    const body: unknown = request.body;
    if (
      !isPlainObject(body) ||
      typeof body.email !== 'string' ||
      typeof body.password !== 'string'
    ) {
      rejectInvalidBody(reply, invalidBodyMessage);
      return;
    }
    const email = normalizeEmail(body.email);
    if (email === null) {
      rejectInvalidBody(reply, INVALID_EMAIL);
      return;
    }
    body.email = email;
    done();
  };
}
