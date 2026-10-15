import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { expect } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { observeHttp } from './gateway-http-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';
import type { Deployment } from './deployment-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

interface Employee {
  id: string;
  cookie: string;
}

function sessionCarrier(base: string, cookie: string, query: string) {
  const url = new URL(base);
  url.protocol = 'ws:';
  url.pathname = '/api/remote.mux';
  url.search = query;
  const socket = new WebSocket(url, { headers: { cookie, host: url.host, origin: base } });
  const frames: Record<string, unknown>[] = [];
  let failure: Error | undefined;
  socket.addEventListener('error', () => {
    failure = new Error('Native carrier failed');
  });
  socket.addEventListener('close', () => {
    failure ??= new Error('Native carrier closed');
  });
  socket.addEventListener('message', (event: MessageEvent) => {
    try {
      if (typeof event.data !== 'string') throw new Error('Expected JSON mux frame');
      frames.push(record(JSON.parse(event.data)));
    } catch {
      failure = new Error('Invalid native mux frame');
    }
  });
  const wait = async (
    streamId: string,
    matches: (frame: Record<string, unknown>) => boolean = () => true,
  ) => {
    let found: Record<string, unknown> | undefined;
    await expect
      .poll(
        () => {
          if (failure !== undefined) throw failure;
          found = frames.find((frame) => frame.streamId === streamId && matches(frame));
          return found !== undefined;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    if (found === undefined) throw new Error('Missing correlated stream frame');
    return found;
  };
  return {
    socket,
    frames,
    wait,
    assertHealthy() {
      if (failure !== undefined) throw failure;
      expect(socket.readyState).toBe(WebSocket.OPEN);
    },
    follow(sessionId: string) {
      const streamId = randomUUID();
      socket.send(
        JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: { args: { request: { address: { kind: 'session', sessionId } } } },
        }),
      );
      return streamId;
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, 'close');
      socket.close();
      await observeHttp(closed, 5_000);
    },
  };
}

export async function verifyStreamIsolation(
  lifecycle: UserImageLifecycle,
  deployment: Deployment,
  a: Employee,
  b: Employee,
) {
  const gateway = instanceGatewayFixture({
    base: deployment.base,
    origin: deployment.base,
    lifecycle,
  });
  const carriers: ReturnType<typeof sessionCarrier>[] = [];
  const failures: unknown[] = [];
  const create = async (user: Employee) => {
    await gateway.state(user.cookie, true);
    await gateway.ready(user.cookie);
    const created = await gateway.rpc(user.cookie, 'session/create', {
      request: { cwd: '/data/work', agentPreset: 'office-general' },
    });
    if (typeof created.sessionId !== 'string') throw new Error('Missing native Session');
    const title = `Stream ${user.id}`;
    await gateway.rpc(user.cookie, 'session/rename', {
      request: { sessionId: created.sessionId, title },
    });
    return { ...user, sessionId: created.sessionId, title };
  };
  try {
    const first = await create(a);
    const second = await create(b);
    expect(first.sessionId).not.toBe(second.sessionId);
    for (const user of [first, second]) {
      const carrier = sessionCarrier(deployment.base, user.cookie, `userId=${a.id}`);
      carriers.push(carrier);
      await observeHttp(once(carrier.socket, 'open'), 15_000);
      const streamId = carrier.follow(user.sessionId);
      expect(await carrier.wait(streamId)).toMatchObject({
        type: 'item',
        value: {
          type: 'snapshot',
          header: { id: user.sessionId },
          projections: { values: { title: user.title } },
        },
      });
    }
    const [carrierA, carrierB] = carriers;
    if (carrierA === undefined || carrierB === undefined) throw new Error('Missing owned carriers');
    const foreign = carrierB.follow(first.sessionId);
    expect(await carrierB.wait(foreign)).toMatchObject({
      type: 'error',
      error: { code: 'session/not-found' },
    });
    for (const [user, carrier] of [
      [first, carrierA],
      [second, carrierB],
    ] as const) {
      const streamId = carrier.frames.find(
        (frame) => record(frame.value).type === 'snapshot',
      )?.streamId;
      if (typeof streamId !== 'string') throw new Error('Missing original stream identity');
      const title = `Live ${user.id}`;
      const renamed = await gateway.rpc(user.cookie, 'session/rename', {
        request: { sessionId: user.sessionId, title },
      });
      const event = await carrier.wait(streamId, (frame) => {
        if (frame.type !== 'item') return false;
        const value = record(frame.value);
        return value.type === 'event' && record(value.event).seq === renamed.seq;
      });
      expect(JSON.stringify(event)).toContain(title);
    }
    expect(
      carrierB.frames.filter((frame) => frame.streamId === foreign).map((frame) => frame.type),
    ).toEqual(['error']);
    const content = JSON.stringify(carrierB.frames.filter((frame) => frame.type === 'item'));
    expect(content).not.toContain(first.sessionId);
    expect(content).not.toContain(first.title);
    expect(content).not.toContain(`Live ${first.id}`);
    expect(carrierB.socket.readyState).toBe(WebSocket.OPEN);
    for (const carrier of carriers) carrier.assertHealthy();
  } catch (error) {
    failures.push(error);
  } finally {
    gateway.close();
    const closed = await Promise.allSettled(carriers.map((carrier) => carrier.close()));
    for (const result of closed) if (result.status === 'rejected') failures.push(result.reason);
  }
  const [firstFailure] = failures;
  if (failures.length === 1 && firstFailure instanceof Error) throw firstFailure;
  if (failures.length > 0) throw new AggregateError(failures, 'Native stream isolation failed');
}
