import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { expect, it } from 'vitest';
import { withListeningApp } from './auth-tcp-fixture.ts';
import { observeHttp } from './gateway-http-fixture.ts';
import { PUBLIC_ORIGIN, withApp } from './auth-fixture.ts';
import { connectActivityPeer } from './gateway-activity-fixture.ts';

it.each(['', 'GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n'])(
  'retires an accepted connection without a parsed request on shutdown: %j',
  async (partialHeaders) => {
    await withListeningApp(async (base, app, database) => {
      const accepted = Promise.withResolvers<Socket>();
      app.server.once('connection', (socket) => {
        accepted.resolve(socket);
      });
      const peer = createConnection({ host: '127.0.0.1', port: Number(new URL(base).port) });
      const peerClosed = once(peer, 'close');
      peer.resume();
      let closing: Promise<void> | undefined;
      try {
        await observeHttp(Promise.all([accepted.promise, once(peer, 'connect')]));
        if (partialHeaders !== '') {
          const received = once(await accepted.promise, 'data');
          peer.write(partialHeaders);
          await observeHttp(received);
        }

        closing = app.close();
        await observeHttp(Promise.all([closing, peerClosed]));

        expect(peer.destroyed).toBe(true);
        expect(database.open).toBe(false);
        expect(app.server.listening).toBe(false);
      } finally {
        // A failing baseline must still retire its own peer; this is not the success oracle.
        peer.destroy();
        await peerClosed;
        await closing;
      }
    });
  },
);

it('retires a late pre-request connection while the existing shutdown hooks are still draining', async () => {
  await withApp(async (app, database) => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    app.addHook('preClose', async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const closing = app.close();
    let peer: Socket | undefined;
    try {
      await observeHttp(entered.promise);
      const accepted = once(app.server, 'connection');
      peer = createConnection({ host: '127.0.0.1', port: Number(new URL(base).port) });
      const closed = once(peer, 'close');
      peer.resume();
      await observeHttp(Promise.all([accepted, once(peer, 'connect')]));

      await observeHttp(closed);

      expect(database.open).toBe(true);
      release.resolve(undefined);
      await observeHttp(closing);
      expect(database.open).toBe(false);
    } finally {
      release.resolve(undefined);
      peer?.destroy();
      await closing;
    }
  });
});

it.each(['body', 'response'] as const)(
  'preserves a parsed registration request with its %s held across shutdown',
  async (stage) => {
    await withApp(async (app, database) => {
      const path = '/_platform/api/register';
      const headersParsed = Promise.withResolvers<undefined>();
      const responseHeld = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const shutdownStarted = Promise.withResolvers<undefined>();
      app.server.on('request', (request) => {
        if (request.url === path) headersParsed.resolve(undefined);
      });
      app.addHook('preSerialization', async (request, _reply, payload: unknown) => {
        if (request.url === path) {
          responseHeld.resolve(undefined);
          await release.promise;
        }
        return payload;
      });
      app.addHook('preClose', (done) => {
        shutdownStarted.resolve(undefined);
        done();
      });
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const port = Number(new URL(base).port);
      const peer = await connectActivityPeer(port);
      const body = JSON.stringify({ email: 'draining@example.test', password: 'test-password' });
      const split = Math.floor(body.length / 2);
      let closing: Promise<void> | undefined;
      try {
        peer.socket.write(
          `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n` +
            `Origin: ${PUBLIC_ORIGIN}\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n` +
            body.slice(0, split),
        );
        await observeHttp(headersParsed.promise);
        if (stage === 'response') {
          peer.socket.write(body.slice(split));
          await observeHttp(responseHeld.promise);
        }

        closing = app.close();
        await observeHttp(shutdownStarted.promise);
        if (stage === 'body') peer.socket.write(body.slice(split));
        await observeHttp(responseHeld.promise);
        expect(database.open).toBe(true);
        release.resolve(undefined);

        const headers = (await peer.read('\r\n\r\n')).toString();
        expect(headers).toMatch(/^HTTP\/1\.1 201 /);
        const length = /content-length:\s*(\d+)/i.exec(headers)?.[1];
        if (length === undefined) throw new Error('Registration response length missing');
        const account: unknown = JSON.parse((await peer.read(Number(length))).toString());
        expect(account).toMatchObject({ email: 'draining@example.test', role: 'employee' });
        await observeHttp(Promise.all([closing, peer.closed]));
        expect(database.open).toBe(false);
      } finally {
        release.resolve(undefined);
        peer.socket.destroy();
        await peer.closed;
        await closing;
      }
    });
  },
);
