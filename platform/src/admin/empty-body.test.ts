import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { createSession } from '../auth/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { withApp } from '../../test/auth-fixture.ts';
import { registerAccount } from '../../test/auth-tcp-fixture.ts';
import { administrator } from '../../test/admin-config-fixture.ts';
import {
  ADMIN_ERRORS,
  authorityRejection,
  EMPTY_BODY_SCHEMA,
  emptyBodyPolicy,
  runConnectionTest,
} from './empty-body.ts';

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

it('rejects a request without a session cookie as 401', async () => {
  await withApp((_app, database) => {
    expect(authorityRejection(database, { headers: {} })).toEqual(ADMIN_ERRORS[401]);
    return Promise.resolve();
  });
});

function setActivity(database: DatabaseHandle, userId: string, at: number): void {
  database
    .prepare('UPDATE platform_sessions SET last_activity_at = ? WHERE user_id = ?')
    .run(at, userId);
}

it('rejects an administrator session idle beyond seven days as 401', async () => {
  await withApp(async (app, database) => {
    const { user, cookie } = await administrator(app, database);
    setActivity(database, user.id, Date.now() - 8 * 86_400_000);

    expect(authorityRejection(database, { headers: { cookie } })).toEqual(ADMIN_ERRORS[401]);
  });
});

it('rejects a current employee session as 403', async () => {
  await withApp(async (app, database) => {
    const employee = await registerAccount(app, 'employee@example.com');
    const cookie = `platform_session=${createSession(database, employee.id, Date.now())}`;

    expect(authorityRejection(database, { headers: { cookie } })).toEqual(ADMIN_ERRORS[403]);
  });
});

it('admits a current administrator session without renewing its activity', async () => {
  await withApp(async (app, database) => {
    const { user, cookie } = await administrator(app, database);
    const idle = Date.now() - 120_000;
    setActivity(database, user.id, idle);

    const rejection = authorityRejection(database, { headers: { cookie } });

    expect(rejection).toBeNull();
    const rows = database
      .prepare('SELECT DISTINCT last_activity_at FROM platform_sessions WHERE user_id = ?')
      .all(user.id);
    expect(rows).toEqual([{ last_activity_at: idle }]);
  });
});

interface Outcome {
  readonly result: 'ok' | 'failed';
  readonly detail: string;
}
type Probe = (signal: AbortSignal, disconnect: () => void) => Promise<Outcome>;
interface ConnectionTestContext {
  readonly post: (cookie: string | undefined) => Promise<[number, unknown]>;
  readonly admin: string;
  readonly employee: string;
  readonly lines: string[];
}

/** A connection-test route over the shared runner, with its own logger and shutdown signal. */
async function withConnectionTest(
  probe: Probe,
  run: (context: ConnectionTestContext) => Promise<void>,
  shutdown = new AbortController().signal,
): Promise<void> {
  await withApp(async (platform, database) => {
    const { cookie: admin } = await administrator(platform, database);
    const user = await registerAccount(platform, 'employee@example.com');
    const employee = `platform_session=${createSession(database, user.id, Date.now())}`;
    const lines: string[] = [];
    const app = Fastify({ logger: { stream: { write: (line: string) => lines.push(line) } } });
    const failure = () => {
      app.log.error('Owned connection test failure');
      return ADMIN_ERRORS[500];
    };
    app.post('/owned/test', (request, reply) =>
      runConnectionTest(
        { database, shutdown, log: app.log, failed: 'Owned connection test failed', failure },
        request,
        reply,
        // The client-disconnect path observes the response's close event.
        (signal) => probe(signal, () => reply.raw.emit('close')),
      ),
    );
    const post = async (cookie: string | undefined): Promise<[number, unknown]> => {
      const response = await app.inject({
        method: 'POST',
        url: '/owned/test',
        headers: cookie === undefined ? {} : { cookie },
      });
      return [response.statusCode, response.json()];
    };
    try {
      await run({ post, admin, employee, lines });
    } finally {
      await app.close();
    }
  });
}

it('returns a successful outcome without logging', async () => {
  await withConnectionTest(
    () => Promise.resolve({ result: 'ok', detail: 'owned' }),
    async ({ post, admin, lines }) => {
      expect(await post(admin)).toEqual([200, { result: 'ok', detail: 'owned' }]);
      expect(lines.join('')).not.toContain('Owned connection test');
    },
  );
});

it('logs only the fixed text and result of a failed outcome', async () => {
  await withConnectionTest(
    () => Promise.resolve({ result: 'failed', detail: 'owned-private-detail' }),
    async ({ post, admin, lines }) => {
      const response = await post(admin);

      expect(response).toEqual([200, { result: 'failed', detail: 'owned-private-detail' }]);
      const logged = lines.filter((line) => line.includes('Owned connection test failed'));
      expect(logged.map((line) => JSON.parse(line) as unknown)).toMatchObject([
        { level: 40, result: 'failed' },
      ]);
      expect(lines.join('')).not.toContain('owned-private-detail');
    },
  );
});

it('rechecks current authority and never runs the test for anonymous or employee callers', async () => {
  const probe = vi.fn<Probe>(() => Promise.resolve({ result: 'ok', detail: '' }));
  await withConnectionTest(probe, async ({ post, employee }) => {
    const anonymous = await post(undefined);
    const forbidden = await post(employee);

    expect(anonymous).toEqual([401, ADMIN_ERRORS[401]]);
    expect(forbidden).toEqual([403, ADMIN_ERRORS[403]]);
    expect(probe).not.toHaveBeenCalled();
  });
});

it('answers a thrown test with the route-owned fixed 500 and its fixed log', async () => {
  await withConnectionTest(
    () => Promise.reject(new Error('owned-private-failure')),
    async ({ post, admin, lines }) => {
      const response = await post(admin);

      expect(response).toEqual([500, ADMIN_ERRORS[500]]);
      expect(lines.join('')).toContain('Owned connection test failure');
      expect(lines.join('')).not.toContain('owned-private-failure');
    },
  );
});

it('aborts the test signal when the client disconnects', async () => {
  const seen: boolean[] = [];
  await withConnectionTest(
    (signal, disconnect) => {
      seen.push(signal.aborted);
      disconnect();
      seen.push(signal.aborted);
      return Promise.resolve({ result: 'ok', detail: '' });
    },
    async ({ post, admin }) => {
      // The injected client treats the response's close as a destroyed response.
      await expect(post(admin)).rejects.toThrow('response destroyed before completion');

      expect(seen).toEqual([false, true]);
    },
  );
});

it('aborts the test signal when the application shuts down', async () => {
  const shutdown = new AbortController();
  const seen: boolean[] = [];
  await withConnectionTest(
    (signal) => {
      seen.push(signal.aborted);
      shutdown.abort();
      seen.push(signal.aborted);
      return Promise.resolve({ result: 'ok', detail: '' });
    },
    async ({ post, admin }) => {
      await post(admin);

      expect(seen).toEqual([false, true]);
    },
    shutdown.signal,
  );
});
