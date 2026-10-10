import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { createSession } from '../src/auth/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { jsonRequestHeaders } from './auth-fixture.ts';
import { registerAccount } from './auth-tcp-fixture.ts';

export const MODEL_CONFIG = {
  baseURL: 'http://models.invalid/v1',
  models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
  defaultModel: 'beta',
};

export function putConfig(app: FastifyInstance, path: string, cookie: string, payload: string) {
  return app.inject({ method: 'PUT', url: path, headers: jsonRequestHeaders({ cookie }), payload });
}

export async function administrator(app: FastifyInstance, database: DatabaseHandle) {
  const user = await registerAccount(app, 'admin@example.com');
  database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
  return { user, cookie };
}

/** Install before listen; mutate authority only after entry admission while body bytes remain held. */
export function delayedConfigBody(app: FastifyInstance, path: string) {
  const admitted = Promise.withResolvers<undefined>();
  app.addHook('preParsing', (request, _reply, payload, done) => {
    if (request.url === path && request.method === 'PUT') admitted.resolve(undefined);
    done(null, payload);
  });
  return async (base: string, cookie: string, body: string, invalidate: () => void) => {
    const completed = Promise.withResolvers<{ status: number; body: string }>();
    const request = httpRequest(
      `${base}${path}`,
      {
        method: 'PUT',
        headers: {
          ...jsonRequestHeaders({ cookie }),
          'content-length': String(Buffer.byteLength(body)),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', completed.reject);
        response.on('end', () => {
          completed.resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', completed.reject);
    try {
      request.write(body.slice(0, 1));
      await Promise.race([
        admitted.promise,
        completed.promise.then(() => {
          throw new Error('request completed before body admission');
        }),
      ]);
      invalidate();
      request.end(body.slice(1));
      return await completed.promise;
    } finally {
      request.destroy();
    }
  };
}
