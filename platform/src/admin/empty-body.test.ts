import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { ADMIN_ERRORS, EMPTY_BODY_SCHEMA, emptyBodyPolicy } from './empty-body.ts';

const MESSAGE = 'Empty owned action body required';

async function withPolicyApp(
  run: (
    inject: (payload: string, contentType?: string) => Promise<[number, unknown]>,
  ) => Promise<void>,
): Promise<void> {
  const app = Fastify({ bodyLimit: 64 });
  const policy = emptyBodyPolicy(MESSAGE);
  app.setErrorHandler(policy.errorHandler(() => ADMIN_ERRORS[500]));
  app.post(
    '/owned',
    {
      validatorCompiler: policy.validatorCompiler,
      preValidation: policy.preValidation,
      schema: { body: EMPTY_BODY_SCHEMA },
    },
    () => ({ admitted: true }),
  );
  try {
    await run(async (payload, contentType = 'application/json') => {
      const response = await app.inject({
        method: 'POST',
        url: '/owned',
        headers: { 'content-type': contentType },
        payload,
      });
      return [response.statusCode, response.json()];
    });
  } finally {
    await app.close();
  }
}

it('admits exactly an empty JSON object', async () => {
  await withPolicyApp(async (inject) => {
    expect(await inject('{}')).toEqual([200, { admitted: true }]);
  });
});

it.each(['null', '[]', '{"extra":1}', '"empty"', '0', 'true', '{'])(
  'rejects %s with the route-owned 400 message',
  async (payload) => {
    await withPolicyApp(async (inject) => {
      expect(await inject(payload)).toEqual([
        400,
        { statusCode: 400, error: 'Bad Request', message: MESSAGE },
      ]);
    });
  },
);

it('maps an oversized body to the fixed 413 and an unparsable media type to the fixed 415', async () => {
  await withPolicyApp(async (inject) => {
    expect(await inject(`{"padding":"${'x'.repeat(128)}"}`)).toEqual([
      413,
      { statusCode: 413, error: 'Payload Too Large', message: 'Request body too large' },
    ]);
    expect(await inject('{}', 'application/x-owned')).toEqual([
      415,
      { statusCode: 415, error: 'Unsupported Media Type', message: 'JSON request body required' },
    ]);
  });
});

it('sends non-transport route failures to the route-owned failure body', async () => {
  const app = Fastify();
  app.setErrorHandler(emptyBodyPolicy(MESSAGE).errorHandler(() => ADMIN_ERRORS[500]));
  app.post('/failing', () => {
    throw new Error('private route failure');
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/failing' });

    expect([response.statusCode, response.json()]).toEqual([500, ADMIN_ERRORS[500]]);
  } finally {
    await app.close();
  }
});

it('leaves non-transport failures to the route owner', () => {
  const policy = emptyBodyPolicy(MESSAGE);

  expect(policy.transportError(new Error('private storage detail'))).toBeUndefined();
  expect(policy.transportError(Object.assign(new Error('x'), { statusCode: 500 }))).toBeUndefined();
  expect(policy.transportError('not an error')).toBeUndefined();
  expect(policy.invalid).toEqual({ statusCode: 400, error: 'Bad Request', message: MESSAGE });
});

it('exposes the fixed administrator authority and failure bodies', () => {
  expect(ADMIN_ERRORS).toEqual({
    401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
    403: { statusCode: 403, error: 'Forbidden', message: 'Forbidden' },
    413: { statusCode: 413, error: 'Payload Too Large', message: 'Request body too large' },
    415: {
      statusCode: 415,
      error: 'Unsupported Media Type',
      message: 'JSON request body required',
    },
    500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
  });
});
