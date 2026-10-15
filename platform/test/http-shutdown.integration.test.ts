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

it.each([
  { stage: 'body', connection: 'close' },
  { stage: 'response', connection: 'close' },
  { stage: 'body', connection: 'keep-alive' },
  { stage: 'response', connection: 'keep-alive' },
])(
  'preserves a parsed registration request with its $stage held across shutdown ($connection)',
  async ({ stage, connection }) => {
    await withApp(async (app, database) => {
      const path = '/_platform/api/register';
      const headersParsed = Promise.withResolvers<undefined>();
      const responseHeld = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
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
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const port = Number(new URL(base).port);
      const peer = await connectActivityPeer(port);
      const cold = await connectActivityPeer(port);
      const body = JSON.stringify({ email: 'draining@example.test', password: 'test-password' });
      const split = Math.floor(body.length / 2);
      let closing: Promise<void> | undefined;
      try {
        peer.socket.write(
          `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n` +
            `Origin: ${PUBLIC_ORIGIN}\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${String(Buffer.byteLength(body))}\r\nConnection: ${connection}\r\n\r\n` +
            body.slice(0, split),
        );
        await observeHttp(headersParsed.promise);
        if (stage === 'response') {
          peer.socket.write(body.slice(split));
          await observeHttp(responseHeld.promise);
        }

        closing = app.close();
        // Observe the shutdown fence without waiting for later preClose hooks to drain.
        await observeHttp(cold.closed);
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
        cold.socket.destroy();
        await peer.closed;
        await closing;
      }
    });
  },
);

it.each(['complete', 'disconnect'])(
  'settles all admitted pipelined responses during shutdown: %s',
  async (outcome) => {
    await withApp(async (app, database) => {
      const first = Promise.withResolvers<undefined>();
      const second = Promise.withResolvers<undefined>();
      const admitted = Promise.withResolvers<undefined>();
      let count = 0;
      app.get(
        '/_platform/drain/:sequence',
        {
          schema: { response: { 200: { type: 'string' } } },
        },
        async (request) => {
          count += 1;
          if (count === 2) admitted.resolve(undefined);
          const isFirst = request.url.endsWith('/first');
          await (isFirst ? first.promise : second.promise);
          return isFirst ? 'first-response' : 'second-response';
        },
      );
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const port = Number(new URL(base).port);
      const peer = await connectActivityPeer(port);
      let closing: Promise<void> | undefined;
      try {
        peer.socket.write(
          ['first', 'second']
            .map(
              (sequence) =>
                `GET /_platform/drain/${sequence} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nConnection: keep-alive\r\n\r\n`,
            )
            .join(''),
        );
        await observeHttp(admitted.promise);

        closing = app.close();
        first.resolve(undefined);
        const headers = (await peer.read('\r\n\r\n')).toString();
        expect(headers).toMatch(/^HTTP\/1\.1 200 /);
        expect(headers).toMatch(/content-length: 14\r\n/i);
        expect((await peer.read(14)).toString()).toBe('first-response');
        expect(database.open).toBe(true);
        if (outcome === 'disconnect') peer.socket.destroy();
        second.resolve(undefined);

        if (outcome === 'complete') {
          const nextHeaders = (await peer.read('\r\n\r\n')).toString();
          expect(nextHeaders).toMatch(/^HTTP\/1\.1 200 /);
          expect(nextHeaders).toMatch(/content-length: 15\r\n/i);
          expect((await peer.read(15)).toString()).toBe('second-response');
        }
        await observeHttp(Promise.all([closing, peer.closed]));
        expect(database.open).toBe(false);
      } finally {
        first.resolve(undefined);
        second.resolve(undefined);
        peer.socket.destroy();
        await peer.closed;
        await closing;
      }
    });
  },
);

it('drains a backpressured response completely before shutdown closes its transport', async () => {
  await withApp(async (app, database) => {
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const admitted = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const buffered = Promise.withResolvers<{ accepted: boolean; queued: number }>();
    app.get(
      '/_platform/drain',
      {
        schema: { response: { 200: { type: 'string' } } },
      },
      async (_request, reply) => {
        admitted.resolve(undefined);
        await release.promise;
        reply.hijack();
        reply.raw.writeHead(200, { 'content-length': payload.length });
        const accepted = reply.raw.write(payload);
        buffered.resolve({ accepted, queued: reply.raw.writableLength });
        reply.raw.end();
        return reply;
      },
    );
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const peer = createConnection({ host: '127.0.0.1', port: Number(new URL(base).port) });
    const closed = once(peer, 'close');
    const ended = Promise.withResolvers<undefined>();
    const chunks: Buffer[] = [];
    peer.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    peer.once('end', () => {
      ended.resolve(undefined);
    });
    peer.pause();
    let closing: Promise<void> | undefined;
    try {
      await observeHttp(once(peer, 'connect'));
      peer.write(
        'GET /_platform/drain HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n',
      );
      await observeHttp(admitted.promise);

      closing = app.close();
      release.resolve(undefined);
      const pressure = await observeHttp(buffered.promise);
      expect(pressure.accepted).toBe(false);
      expect(pressure.queued).toBeGreaterThan(0);
      expect(database.open).toBe(true);
      peer.resume();

      await observeHttp(Promise.all([ended.promise, closed, closing]));
      const response = Buffer.concat(chunks);
      const boundary = response.indexOf('\r\n\r\n');
      expect(response.subarray(0, boundary).toString()).toMatch(/^HTTP\/1\.1 200 /);
      expect(response.subarray(boundary + 4).length).toBe(payload.length);
      expect(response.subarray(boundary + 4).equals(payload)).toBe(true);
      expect(database.open).toBe(false);
    } finally {
      release.resolve(undefined);
      peer.destroy();
      await closed;
      await closing;
    }
  });
});
