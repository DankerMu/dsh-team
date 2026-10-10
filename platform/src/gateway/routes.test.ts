import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { withApp } from '../../test/auth-fixture.ts';
import { observeHttp } from '../../test/gateway-http-fixture.ts';

it.each([
  ['GET', 'text/html', 302],
  ['HEAD', 'application/json, TEXT/HTML; q=0.5', 302],
  ['GET', 'text/html;q=0, */*', 401],
  ['GET', 'application/json', 401],
  ['GET', undefined, 401],
  ['POST', 'text/html', 401],
] as const)(
  'classifies %s accepting %s without redirecting non-navigation traffic',
  async (method, accept, status) => {
    await withApp(async (app) => {
      const response = await app.inject({
        method,
        url: '/',
        headers: accept === undefined ? {} : { accept },
      });

      expect(response.statusCode).toBe(status);
      expect(response.headers.location).toBe(status === 302 ? '/_platform/login' : undefined);
    });
  },
);

it.each([
  ['/_platform', 404],
  ['/_platform/unknown?user=someone', 404],
  ['/_platform-other', 401],
  ['/healthz/', 401],
  ['/_platform%2Funknown', 401],
] as const)('keeps the namespace boundary for %s', async (url, status) => {
  await withApp(async (app) => {
    const response = await app.inject({ url });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ statusCode: status });
  });
});

it('rejects upgrade storage failures without disclosing details and consumes peer errors', async () => {
  await withApp(async (app, database) => {
    await app.ready();
    database.exec('DROP TABLE platform_sessions');
    const request = new IncomingMessage(new Socket());
    request.url = '/';
    request.headers.cookie = `platform_session=${'a'.repeat(64)}`;
    const socket = new PassThrough();
    let response = '';
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString();
    });

    app.server.emit('upgrade', request, socket, Buffer.alloc(0));
    socket.emit('error', new Error('peer reset'));

    expect(response).toBe(
      'HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
    expect(socket.destroyed).toBe(true);
    request.destroy();
  });
});

it('aborts an HTTP request queued before the application shutdown fence', async () => {
  await withApp(async (app) => {
    const entered = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const closing = Promise.withResolvers<undefined>();
    app.addHook('onRequest', async () => {
      entered.resolve(undefined);
      await resume.promise;
    });
    app.addHook('preClose', (done) => {
      closing.resolve(undefined);
      done();
    });
    const response = app.inject({ url: '/queued' });
    const rejected = expect(response).rejects.toBeInstanceOf(Error);
    try {
      await observeHttp(entered.promise);
      const closed = app.close();
      await observeHttp(closing.promise);

      resume.resolve(undefined);

      await observeHttp(rejected);
      await observeHttp(closed);
    } finally {
      resume.resolve(undefined);
    }
  });
});
