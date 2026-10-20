import { once } from 'node:events';
import { createConnection, createServer, Socket } from 'node:net';
import { expect, it } from 'vitest';
import { byteListener } from '../../scripts/byte-listener.mjs';
import { observeHttp, withUpstream } from './gateway-http-fixture.ts';

it('keeps its first backend after refusing replacement and leaves the other listener usable', async () => {
  const payload = Buffer.concat([Buffer.from('原始响应'), Buffer.from([0, 255, 128, 13, 10])]);
  await withUpstream(
    (_request, response) => response.end(payload),
    async (first) => {
      await withUpstream(
        (_request, response) => response.end('other-backend'),
        async (other) => {
          const listener = byteListener({ host: '127.0.0.1', port: 0 });
          try {
            await listener.ready;
            const address = listener.server.address();
            if (address === null || typeof address === 'string')
              throw new Error('Missing relay address');
            listener.forwardTo({ host: first.host, port: first.port });

            expect(() => {
              listener.forwardTo({ host: other.host, port: other.port });
            }).toThrow();
            const response = await observeHttp(fetch(`http://127.0.0.1:${String(address.port)}/`));
            expect(Buffer.from(await observeHttp(response.arrayBuffer()))).toEqual(payload);
            await observeHttp(listener.close());

            const independent = await observeHttp(
              fetch(`http://${other.host}:${String(other.port)}/`),
            );
            expect(await observeHttp(independent.text())).toBe('other-backend');
          } finally {
            await listener.close();
          }
        },
      );
    },
  );
});

it('settles its original bind before early close and never activates a retired listener', async () => {
  const listener = byteListener({ host: '127.0.0.1', port: 0 });
  const bound = Promise.withResolvers<ReturnType<typeof listener.server.address>>();
  listener.server.once('listening', () => {
    bound.resolve(listener.server.address());
  });
  try {
    const closing = listener.close();
    await observeHttp(Promise.all([listener.ready, closing]));
    const address = await observeHttp(bound.promise);
    if (address === null || typeof address === 'string')
      throw new Error('Original bind was not observed');

    expect(listener.server.listening).toBe(false);
    expect(() => {
      listener.forwardTo({ host: '127.0.0.1', port: address.port });
    }).toThrow();
    const replacement = createServer();
    try {
      replacement.listen(address.port, '127.0.0.1');
      await observeHttp(once(replacement, 'listening'));
      expect(replacement.address()).toMatchObject({ address: '127.0.0.1', port: address.port });
    } finally {
      if (replacement.listening) {
        const closed = once(replacement, 'close');
        replacement.close();
        await observeHttp(closed);
      }
    }
  } finally {
    await listener.close();
  }
});

it('retires both accepted peers during closure without retiring its backend server', async () => {
  await withUpstream(
    (_request, response) => response.end('backend-survived'),
    async (target, backend) => {
      const accepted = once(backend, 'connection');
      const listener = byteListener({ host: '127.0.0.1', port: 0 });
      let client: Socket | undefined;
      try {
        await listener.ready;
        listener.forwardTo({ host: target.host, port: target.port });
        const address = listener.server.address();
        if (address === null || typeof address === 'string')
          throw new Error('Missing relay address');
        client = createConnection({ host: '127.0.0.1', port: address.port });
        const clientClosed = Promise.withResolvers<undefined>();
        client.once('close', () => {
          clientClosed.resolve(undefined);
        });
        client.on('error', () => client?.destroy());
        await observeHttp(once(client, 'connect'));
        client.write('GET / HTTP/1.1\r\nHost: owned\r\n');
        const peer: unknown = (await observeHttp(accepted))[0];
        if (!(peer instanceof Socket)) throw new Error('Missing accepted backend socket');
        const peerClosed = Promise.withResolvers<undefined>();
        peer.once('close', () => {
          peerClosed.resolve(undefined);
        });
        peer.on('error', () => peer.destroy());
        expect(client.destroyed).toBe(false);
        expect(peer.destroyed).toBe(false);

        await observeHttp(
          Promise.all([listener.close(), clientClosed.promise, peerClosed.promise]),
        );

        expect(client.destroyed).toBe(true);
        expect(peer.destroyed).toBe(true);
        expect(backend.listening).toBe(true);
        const response = await observeHttp(fetch(`http://${target.host}:${String(target.port)}/`));
        expect(await observeHttp(response.text())).toBe('backend-survived');
      } finally {
        client?.destroy();
        await listener.close();
      }
    },
  );
});
