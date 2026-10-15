import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { reader } from './gateway-http-fixture.ts';
import { waitDockerIdle } from './instance-idle-docker-fixture.ts';
import type { DockerIdleContext } from './instance-idle-docker-fixture.ts';

/** Real platform gateway, real DSH protocol and invocation-owned Docker observations. */
export function instanceGatewayFixture(
  f: Pick<DockerIdleContext, 'base' | 'origin' | 'lifecycle'>,
) {
  const sockets: Socket[] = [];
  const headers = (cookie: string) => ({
    cookie,
    origin: f.origin,
    'content-type': 'application/json',
  });
  const rpcResult = async (
    cookie: string,
    method: string,
    args: unknown,
    attack: { query?: string; headers?: Record<string, string> } = {},
  ) => {
    const rpcId = randomUUID();
    const response = await fetch(`${f.base}/api/${method}${attack.query ?? ''}`, {
      method: 'POST',
      headers: { ...headers(cookie), ...attack.headers },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    });
    expect(response.status).toBe(200);
    const envelope = record(await response.json());
    expect(envelope).toMatchObject({ type: 'server-response', rpcId });
    return record(envelope.result);
  };
  const rpc = async (cookie: string, method: string, args: unknown) => {
    const result = await rpcResult(cookie, method, args);
    expect(result.ok).toBe(true);
    return record(result.value);
  };
  const exec = async (id: string, script: string): Promise<string> => {
    const result = await f.lifecycle.commandAsync(
      ['exec', '--user', '1001', id, 'node', '--input-type=module', '-e', script],
      15_000,
    );
    if (result.status !== 0 || result.error !== undefined)
      throw new Error('Owned data observation failed');
    return result.stdout.trim();
  };
  const state = async (cookie: string, start = false) => {
    const response = await fetch(`${f.base}/_platform/api/instance${start ? '/start' : ''}`, {
      method: start ? 'POST' : 'GET',
      headers: headers(cookie),
      ...(start ? { body: '{}' } : {}),
    });
    expect(response.status).toBe(200);
    return record(await response.json());
  };
  const ready = async (cookie: string) => {
    const signal = AbortSignal.timeout(90_000);
    for (;;) {
      const observed = await state(cookie);
      if (observed.status === 'running') {
        expect(observed).toEqual({ status: 'running', reason: null });
        return;
      }
      expect(observed).toEqual({ status: 'starting', reason: 'starting' });
      await delay(100, undefined, { signal });
    }
  };
  const open = async (cookie: string) => {
    const url = new URL(f.base);
    const socket = connect(Number(url.port), '127.0.0.1');
    sockets.push(socket);
    socket.on('error', () => undefined);
    const closed = Promise.withResolvers<number>();
    socket.once('close', () => {
      closed.resolve(performance.now());
    });
    await once(socket, 'connect');
    const read = reader(socket);
    socket.write(
      `GET /api/remote.mux HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${cookie}\r\nOrigin: ${f.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
    );
    expect((await read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 101 /);
    // These idle real peers must answer released DSH heartbeat pings during restart.
    // No logical mux stream is opened here; idle carriers receive only control frames.
    let frames = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      frames = Buffer.concat([frames, chunk]);
      while (frames.length >= 2) {
        const length = frames.readUInt8(1) & 127;
        if (length > 125) throw new Error('Unexpected non-control frame on idle DSH peer');
        if (frames.length < length + 2) return;
        if ((frames.readUInt8(0) & 15) === 9) {
          const mask = randomBytes(4);
          const pong = Buffer.alloc(length + 6);
          pong[0] = 0x8a;
          pong[1] = 0x80 | length;
          mask.copy(pong, 2);
          for (let i = 0; i < length; i++)
            pong[i + 6] = frames.readUInt8(i + 2) ^ mask.readUInt8(i % 4);
          socket.write(pong);
        }
        frames = frames.subarray(length + 2);
      }
    });
    socket.resume();
    return { socket, closed: closed.promise };
  };

  async function history(cookie: string, sessionId: string): Promise<readonly unknown[]> {
    const projection = await rpc(cookie, 'session/projections', { request: { sessionId } });
    const cursor = projection.asOfSeq;
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < -1)
      throw new Error('Invalid genuine history cursor');
    const historyRecords: unknown[] = [];
    let lastSeq = cursor;
    for (;;) {
      const page = await rpc(cookie, 'session/page', {
        request: {
          address: { kind: 'session', sessionId },
          throughSeq: cursor,
          maxMessages: 10,
          ...(lastSeq === cursor ? {} : { beforeSeq: lastSeq + 1 }),
        },
      });
      const records: unknown = page.records;
      if (!Array.isArray(records)) throw new Error('Missing genuine history');
      const firstSeq = lastSeq - records.length + 1;
      if (firstSeq < 0 || (records.length === 0 && lastSeq !== -1) || page.hasMore !== firstSeq > 0)
        throw new Error('Incomplete genuine history page');
      for (let index = records.length - 1; index >= 0; index--) {
        const row: unknown = records[index];
        if (record(record(row).event).seq !== firstSeq + index)
          throw new Error('Discontinuous genuine history page');
        historyRecords.push(row);
      }
      if (!page.hasMore) return historyRecords.reverse();
      lastSeq = firstSeq - 1;
    }
  }
  async function persistedSession(context: Pick<DockerIdleContext, 'user' | 'control'>) {
    const created = await rpc(context.user.cookie, 'session/create', {
      request: { cwd: '/data/work', agentPreset: 'standard' },
    });
    if (typeof created.sessionId !== 'string') throw new Error('Missing genuine Session');
    const sessionId = created.sessionId;
    await context.control({ op: 'adopt', sessionId });
    await waitDockerIdle(async () => {
      const status = await context.control({ op: 'status' });
      return (
        Array.isArray(status.audit) &&
        status.audit.some((value: unknown) => {
          const event = record(value);
          return (
            event.sessionId === sessionId &&
            event.type === 'turn/end' &&
            record(record(event.data).reason).kind === 'completed'
          );
        })
      );
    });
    expect((await context.control({ op: 'status' })).externalModelCalls).toBe(0);
    const originalHistory = await history(context.user.cookie, sessionId);
    const events = originalHistory.map((value: unknown) => record(record(value).event));
    expect(
      events.filter(
        (event) =>
          event.type === 'user/message' && record(record(event.data).source).kind === 'user',
      ),
    ).toMatchObject([
      { data: { role: 'user', content: [{ type: 'text', text: 'issue83-ui initialize' }] } },
    ]);
    expect(events.filter((event) => event.type === 'assistant/message')).toMatchObject([
      {
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Owned protocol fixture idle.' }],
          },
        },
      },
    ]);
    return { sessionId, originalHistory };
  }

  return {
    rpc,
    rpcResult,
    exec,
    state,
    ready,
    open,
    history,
    persistedSession,
    close: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
}

/** Compare durable mounts without coupling to Docker's incidental inventory ordering. */
export function orderedMounts(value: unknown, volumesOnly = true) {
  if (!Array.isArray(value)) throw new Error('Missing mount inventory');
  return value
    .map((entry: unknown) => record(entry))
    .filter((entry) => !volumesOnly || entry.Type === 'volume')
    .sort((a, b) => String(a.Destination).localeCompare(String(b.Destination)));
}
