import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

const INVALID_EMAIL = 'Invalid email';
const INTERNAL_WHITESPACE = /\s/;

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
    const email = body.email.trim().toLowerCase();
    const at = email.indexOf('@');
    if (
      at <= 0 ||
      at !== email.lastIndexOf('@') ||
      at >= email.length - 1 ||
      INTERNAL_WHITESPACE.test(email)
    ) {
      rejectInvalidBody(reply, INVALID_EMAIL);
      return;
    }
    body.email = email;
    done();
  };
}
