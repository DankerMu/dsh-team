import { json } from 'node:stream/consumers';
import { expect, it } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { withUpstream } from './gateway-http-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';

async function withHistoryProtocol(
  reply: (method: unknown, input: Record<string, unknown>) => unknown,
  run: (history: () => Promise<readonly unknown[]>) => Promise<void>,
) {
  await withUpstream(
    (request, response) => {
      void json(request)
        .then((body: unknown) => {
          const envelope = record(body);
          const input = record(record(record(envelope.payload).args).request);
          const value = reply(envelope.method, input);
          response.end(
            JSON.stringify({
              type: 'server-response',
              rpcId: envelope.rpcId,
              result: { ok: true, value },
            }),
          );
        })
        .catch(() => {
          response.statusCode = 500;
          response.end('{}');
        });
    },
    async ({ host, port }) => {
      const base = `http://${host}:${String(port)}`;
      const gateway = instanceGatewayFixture({
        base,
        origin: base,
        get lifecycle(): never {
          throw new Error('History must not access Docker');
        },
      });
      await run(() => gateway.history('owned-cookie', 'owned-session'));
    },
  );
}

it('reads the complete frozen history including older metadata-only pages', async () => {
  const rows = Array.from({ length: 6 }, (_, seq) => ({ event: { seq } }));
  let projections = 0;
  const pages: unknown[] = [];

  await withHistoryProtocol(
    (method, input) => {
      if (method === 'session/projections') {
        projections++;
        return { asOfSeq: projections === 1 ? 5 : 99 };
      }
      pages.push(input);
      const end = typeof input.beforeSeq === 'number' ? input.beforeSeq : 6;
      const start = Math.max(0, end - 2);
      return { records: rows.slice(start, end), hasMore: start > 0 };
    },
    async (history) => {
      expect(await history()).toEqual(rows);
      expect(projections).toBe(1);
      expect(pages).toEqual(
        [undefined, 4, 2].map((beforeSeq) => ({
          address: { kind: 'session', sessionId: 'owned-session' },
          throughSeq: 5,
          maxMessages: 10,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        })),
      );
    },
  );
});

it.each([-1, 0, 3])('preserves complete single-page history at cursor %s', async (cursor) => {
  const rows = Array.from({ length: cursor + 1 }, (_, seq) => ({ event: { seq } }));

  await withHistoryProtocol(
    (method) =>
      method === 'session/projections' ? { asOfSeq: cursor } : { records: rows, hasMore: false },
    async (history) => {
      expect(await history()).toEqual(rows);
    },
  );
});

it.each([
  { name: 'missing prefix', seqs: [1, 2], hasMore: false },
  { name: 'missing suffix', seqs: [0, 1], hasMore: false },
  { name: 'gap', seqs: [0, 2], hasMore: true },
  { name: 'duplicate', seqs: [1, 1, 2], hasMore: false },
  { name: 'future sequence', seqs: [2, 3], hasMore: true },
  { name: 'empty continuation', seqs: [], hasMore: true },
  { name: 'false continuation', seqs: [0, 1, 2], hasMore: true },
  { name: 'missing continuation flag', seqs: [0, 1, 2], hasMore: undefined },
])('rejects $name rather than returning partial evidence', async ({ seqs, hasMore }) => {
  await withHistoryProtocol(
    (method) =>
      method === 'session/projections'
        ? { asOfSeq: 2 }
        : { records: seqs.map((seq) => ({ event: { seq } })), hasMore },
    async (history) => {
      await expect(history()).rejects.toThrow(/genuine history page/);
    },
  );
});

it('rejects overlap between individually ordered pages', async () => {
  await withHistoryProtocol(
    (method, input) => {
      if (method === 'session/projections') return { asOfSeq: 3 };
      const seqs = input.beforeSeq === undefined ? [2, 3] : [1, 2];
      return {
        records: seqs.map((seq) => ({ event: { seq } })),
        hasMore: input.beforeSeq === undefined,
      };
    },
    async (history) => {
      await expect(history()).rejects.toThrow('Discontinuous genuine history page');
    },
  );
});

it.each([undefined, '2', -2, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid snapshot cursor %s before requesting history',
  async (cursor) => {
    let pages = 0;
    await withHistoryProtocol(
      (method) => {
        if (method === 'session/projections') return { asOfSeq: cursor };
        pages++;
        return {};
      },
      async (history) => {
        await expect(history()).rejects.toThrow('Invalid genuine history cursor');
        expect(pages).toBe(0);
      },
    );
  },
);
