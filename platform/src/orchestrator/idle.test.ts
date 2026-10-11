import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { IncomingMessage, type RequestOptions } from 'node:http';
import type * as HttpModule from 'node:http';
import { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { expect, it, vi } from 'vitest';
import {
  startupOwnerFixture,
  START_CONTAINER,
  START_USER,
  startupBarrier,
} from '../../test/container-start-fixture.ts';
import { instanceConfig } from '../../test/instance-fixture.ts';
import { buildApp } from '../app.ts';
import { writeSettings } from '../db/index.ts';
import { createInstanceService } from './instance-service.ts';

const wire = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:http', async (original) => ({
  ...(await original<typeof HttpModule>()),
  request: wire.request,
}));

async function fixture() {
  const f = await startupOwnerFixture();
  const service = createInstanceService({ ...f, config: instanceConfig(f.root, f.input.config) });
  writeSettings(f.database, {
    idleMinutes: 1,
    modelBaseUrl: 'http://model.invalid/v1',
    modelApiKey: 'unit-fixture',
    models: [{ name: 'office-model' }],
    defaultModel: 'office-model',
  });
  await f.owner.startUserContainer(f.input);
  f.database.prepare("UPDATE instances SET status='running',dsh_cookie='owned-cookie'").run();
  let now = 600_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  let liveCount = 0;
  let lastActivityAt: number | null = null;
  let task: 'idle' | 'busy' | 'unknown' = 'idle';
  let gate: Promise<undefined> | undefined;
  let afterReply: (() => void) | undefined;
  const sockets: Socket[] = [];
  wire.request.mockImplementation(
    (_options: RequestOptions, receive: (incoming: IncomingMessage) => void) => {
      const outgoing = new EventEmitter();
      let destroyed = false;
      _options.signal?.addEventListener(
        'abort',
        () => outgoing.emit('error', new Error('Owned boundary canceled')),
        { once: true },
      );
      Object.assign(outgoing, {
        destroy: () => {
          destroyed = true;
        },
        end: (body: string) => {
          const envelope: unknown = JSON.parse(body);
          if (typeof envelope !== 'object' || envelope === null || !('rpcId' in envelope))
            throw new Error('Missing fixture envelope');
          const send = () => {
            if (destroyed) return;
            const socket = new Socket();
            sockets.push(socket);
            const incoming = new IncomingMessage(socket);
            incoming.statusCode = task === 'unknown' ? 503 : 200;
            incoming.complete = true;
            receive(incoming);
            incoming.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  type: 'server-response',
                  rpcId: envelope.rpcId,
                  result: { ok: true, value: { items: [{ running: task === 'busy' }] } },
                }),
              ),
            );
            incoming.emit('end');
            if (afterReply !== undefined) queueMicrotask(afterReply);
          };
          if (gate === undefined) queueMicrotask(send);
          else void gate.then(send);
        },
      });
      return outgoing;
    },
  );
  return {
    ...f,
    service,
    getActivity: () => ({ liveCount, lastActivityAt }),
    now(value: number) {
      now = value;
    },
    activity(count: number, at: number | null = null) {
      liveCount = count;
      lastActivityAt = at;
    },
    tasks(value: typeof task) {
      task = value;
    },
    hold(value: Promise<undefined> | undefined) {
      gate = value;
    },
    replyBoundary(operation: () => void) {
      afterReply = operation;
    },
    async close() {
      await service.close();
      clock.mockRestore();
      for (const socket of sockets) socket.destroy();
      wire.request.mockReset();
      f.database.close();
      await rm(f.root, { recursive: true, force: true });
    },
  };
}

it.each([
  'busy',
  'unknown',
  'connection',
  'activity',
  'backwards',
  'identity',
  'credential',
] as const)('does not carry continuous idle across %s', async (change) => {
  const f = await fixture();
  try {
    await f.service.checkIdle(f.getActivity);
    f.now(660_000);
    if (change === 'busy' || change === 'unknown') f.tasks(change);
    else if (change === 'connection') f.activity(1);
    else if (change === 'activity') f.activity(0, 659_999);
    else if (change === 'backwards') f.now(599_999);
    else if (change === 'credential')
      f.database.prepare("UPDATE instances SET dsh_cookie='replacement-cookie'").run();
    else f.database.prepare('UPDATE instances SET last_started_at=777').run();
    await f.service.checkIdle(f.getActivity);
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    f.tasks('idle');
    f.activity(0, change === 'activity' ? 659_999 : null);
    f.now(change === 'backwards' ? 599_999 : 660_000);
    await f.service.checkIdle(f.getActivity);
    f.now(change === 'backwards' ? 659_998 : 719_999);
    await f.service.checkIdle(f.getActivity);
    expect(f.service.status(START_USER)).toEqual({ status: 'running', reason: null });
    f.now(change === 'backwards' ? 659_999 : 720_000);
    await f.service.checkIdle(f.getActivity);
    expect(f.service.status(START_USER)).toEqual({ status: 'stopped', reason: 'stopped' });
  } finally {
    await f.close();
  }
});

it('prunes idle ownership for nonrunning accounts and rejects checks after close', async () => {
  const f = await fixture();
  try {
    await f.service.checkIdle(f.getActivity);
    f.database.prepare("UPDATE instances SET status='stopped'").run();
    await f.service.checkIdle(f.getActivity);
    f.database.prepare("UPDATE instances SET status='running',dsh_cookie=NULL").run();
    await f.service.checkIdle(f.getActivity);
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    await f.service.close();
    await expect(f.service.checkIdle(f.getActivity)).rejects.toThrow(
      'Instance service unavailable',
    );
  } finally {
    await f.close();
  }
});

it('coalesces held observations and rejects same-time events or explicit starts before stop admission', async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<undefined>();
  try {
    await f.service.checkIdle(f.getActivity);
    f.now(660_000);
    f.hold(gate.promise);
    const checking = f.service.checkIdle(f.getActivity);
    expect(f.service.checkIdle(f.getActivity)).toBe(checking);
    await Promise.resolve();
    await Promise.resolve();
    f.service.recordActivity(START_USER, 660_000);
    const starting = f.service.start(START_USER);
    gate.resolve(undefined);
    await checking;
    expect(await starting).toEqual({ status: 'running', reason: null });
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
  } finally {
    gate.resolve(undefined);
    await f.close();
  }
});

it.each(['start-identity', 'credential-only', 'endpoint-only'] as const)(
  'releases a failed retirement fence without poisoning %s, while protecting the same retiring container',
  async (replacement) => {
    const f = await fixture();
    const stop = startupBarrier();
    try {
      await f.service.checkIdle(f.getActivity);
      f.now(660_000);
      f.beforeRequest(async (method, path) =>
        method === 'POST' && path.startsWith(`/containers/${START_CONTAINER}/stop?`)
          ? stop.hold()
          : undefined,
      );
      f.daemon.overrides.set(`POST /containers/${START_CONTAINER}/stop?t=1`, { status: 500 });
      const checking = f.service.checkIdle(f.getActivity);
      const rejected = expect(checking).rejects.toThrow('Idle instance check failed');
      await stop.reached;
      expect(f.service.resolveUpstream(START_USER)).toEqual({ outcome: 'starting' });
      if (replacement === 'start-identity')
        f.database.prepare('UPDATE instances SET last_started_at=777').run();
      else if (replacement === 'credential-only')
        f.database.prepare("UPDATE instances SET dsh_cookie='replacement-cookie'").run();
      else f.database.prepare('UPDATE instances SET upstream_port=49174').run();
      expect(f.service.resolveUpstream(START_USER).outcome).toBe(
        replacement === 'start-identity' ? 'running' : 'starting',
      );
      stop.release();
      await rejected;
      expect(f.service.resolveUpstream(START_USER).outcome).toBe('running');
    } finally {
      stop.release();
      await f.close();
    }
  },
);

it('reports an activity-source failure without preventing another sweep from observing current state', async () => {
  const f = await fixture();
  try {
    await expect(
      f.service.checkIdle(() => {
        throw new Error('private source');
      }),
    ).rejects.toThrow('Idle instance check failed');
    await f.service.checkIdle(f.getActivity);
    f.now(660_000);
    await f.service.checkIdle(f.getActivity);
    expect(f.service.status(START_USER)).toEqual({ status: 'stopped', reason: 'stopped' });
  } finally {
    await f.close();
  }
});

it.each(['activity', 'settings'] as const)(
  'rechecks %s arriving at the external RPC completion boundary before retirement',
  async (change) => {
    const f = await fixture();
    try {
      await f.service.checkIdle(f.getActivity);
      f.now(660_000);
      let changed = false;
      f.replyBoundary(() => {
        if (change === 'activity') f.service.recordActivity(START_USER, 660_000);
        else writeSettings(f.database, { idleMinutes: 30 });
        changed = true;
      });
      await f.service.checkIdle(f.getActivity);
      expect(changed).toBe(true);
      expect(f.service.status(START_USER)).toEqual({ status: 'running', reason: null });
      expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
      expect(
        f.database
          .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
          .all(),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it.each([
  'container_id=NULL',
  'image_id=NULL',
  "upstream_host=''",
  'upstream_port=NULL',
  "dsh_cookie=''",
] as const)(
  'preserves an unobservable running instance with %s rather than guessing idle',
  async (update) => {
    const f = await fixture();
    try {
      f.database.exec(`UPDATE instances SET ${update}`);
      await f.service.checkIdle(f.getActivity);
      f.now(900_000);
      await f.service.checkIdle(f.getActivity);
      expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
      expect(
        f.database
          .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
          .all(),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it('cancels an outstanding observation on close without admitting retirement', async () => {
  const f = await fixture();
  const hold = Promise.withResolvers<undefined>();
  try {
    f.hold(hold.promise);
    const checking = f.service.checkIdle(f.getActivity);
    await Promise.resolve();
    await Promise.resolve();
    await f.service.close();
    await checking;
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    expect(f.database.open).toBe(true);
  } finally {
    hold.resolve(undefined);
    await f.close();
  }
});

it('an application minute sweep observes a real retirement failure without inventing a stopped row or losing its endpoint', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const ticks = vi.spyOn(f.service, 'checkIdle');
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp(
      instanceConfig(f.root, f.input.config),
      f.database,
      undefined,
      undefined,
      f.service,
    );
    await app.ready();
    await f.service.checkIdle(app.getUserActivity);
    f.now(660_000);
    f.daemon.overrides.set(`POST /containers/${START_CONTAINER}/stop?t=1`, { status: 500 });
    const before = ticks.mock.results.length;
    await vi.advanceTimersByTimeAsync(60_000);
    const tick = ticks.mock.results[before];
    if (tick?.type !== 'return') throw new Error('Missing actual minute sweep');
    await expect(tick.value).rejects.toThrow('Idle instance check failed');
    // App observes the rejected real work; no fake service result or hidden successful stop.
    expect(f.service.resolveUpstream(START_USER).outcome).toBe('running');
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    expect(
      f.database
        .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
        .all(),
    ).toEqual([]);
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await f.close();
      } finally {
        ticks.mockRestore();
        vi.useRealTimers();
      }
    }
  }
});
