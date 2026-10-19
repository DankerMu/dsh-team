import { expect, it, vi } from 'vitest';
import { START_CONTAINER, START_USER, startupBarrier } from '../../test/container-start-fixture.ts';
import { RECONCILE_COOKIE } from '../../test/container-reconcile-fixture.ts';
import {
  instanceServiceFixture as fixture,
  configureInstanceModel as configure,
  heldReadinessLogs,
} from '../../test/instance-fixture.ts';

it.each(['deadline', 'disabled'] as const)(
  'settles an applied create before durable recovery after %s cancellation',
  async (kind) => {
    const gate = startupBarrier();
    const deadline = new AbortController();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const clock =
      kind === 'deadline'
        ? vi
            .spyOn(AbortSignal, 'timeout')
            .mockImplementation((duration) =>
              duration === 60_000 ? deadline.signal : originalTimeout(duration),
            )
        : undefined;
    const f = await fixture((client) => ({
      ...client,
      async json(method, path, body, signal, maxBytes) {
        const result = await client.json(method, path, body, signal, maxBytes);
        if (path === `/containers/create?name=dsh-team-u-${START_USER}`) {
          await gate.hold();
          signal?.throwIfAborted();
        }
        return result;
      },
    }));
    try {
      configure(f.database);
      const starting = expect(f.service.start(START_USER)).rejects.toThrow(
        'Instance operation failed',
      );
      await gate.reached;
      expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(false);
      let stopped = false;
      let stopping: Promise<void> | undefined;
      if (kind === 'disabled') {
        f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
        stopping = f.service.stop(START_USER, 'disabled').then(() => {
          stopped = true;
        });
        expect(stopped).toBe(false);
      } else deadline.abort();
      expect(f.service.status('mnopqrstuvwx')).toEqual({ status: 'stopped', reason: 'stopped' });
      gate.release();
      await starting;
      stopping ??= f.service.stop(START_USER, 'admin');
      await stopping;

      expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
      expect(f.database.prepare('SELECT * FROM creation_attempts').all()).toEqual([]);
      expect(f.service.status(START_USER)).toEqual({ status: 'error', reason: 'error' });
      expect(
        f.daemon.requests.some(({ path }) => path === `/containers/${START_CONTAINER}/start`),
      ).toBe(false);
      expect(
        f.database.prepare("SELECT * FROM audit_events WHERE event_type='instance.stopped'").all(),
      ).toEqual([]);
    } finally {
      gate.release();
      clock?.mockRestore();
      await f.close();
    }
  },
);

it.each(['missing', 'stopped', 'error'] as const)(
  'disabled retirement safely confirms %s without fabricated stop audits',
  async (kind) => {
    const f = await fixture();
    try {
      f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
      if (kind !== 'missing')
        f.database
          .prepare('INSERT INTO instances(user_id,status) VALUES (?,?)')
          .run(START_USER, kind);
      await f.service.stop(START_USER, 'disabled');
      await f.service.stop(START_USER, 'disabled');
      expect(f.daemon.requests).toEqual([]);
      expect(f.database.prepare('SELECT * FROM audit_events').all()).toEqual([]);
      expect(f.database.prepare('SELECT status,container_id FROM instances').all()).toEqual(
        kind === 'missing' ? [] : [{ status: kind, container_id: null }],
      );
    } finally {
      await f.close();
    }
  },
);

it('retires a retained error container and rejects newly active authority before disabled retirement selection', async () => {
  const f = await fixture();
  try {
    await f.owner.startUserContainer(f.input);
    f.database.prepare("UPDATE instances SET status='error',dsh_cookie=NULL").run();
    const before = f.database.prepare('SELECT * FROM instances').get();
    await expect(f.service.stop(START_USER, 'disabled')).rejects.toThrow(
      'User container retirement failed',
    );
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    expect(f.database.prepare('SELECT * FROM instances').get()).toEqual(before);
    f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
    await f.service.stop(START_USER, 'disabled');
    expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(
      f.database.prepare('SELECT status,container_id,dsh_cookie FROM instances').get(),
    ).toEqual({ status: 'stopped', container_id: null, dsh_cookie: null });
    expect(
      f.database
        .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
        .all(),
    ).toEqual([{ details: '{"reason":"disabled"}' }]);
  } finally {
    await f.close();
  }
});

it('cancels held startup without later readiness, and close retains real work until the Engine settles', async () => {
  const f = await fixture();
  const gate = startupBarrier();
  try {
    configure(f.database);
    let signal: AbortSignal | undefined;
    f.beforeRequest(async (method, path, captured) => {
      if (method === 'GET' && path.startsWith('/images/')) {
        signal = captured;
        await gate.hold();
      }
      return undefined;
    });
    const start = expect(f.service.start(START_USER)).rejects.toThrow('Instance operation failed');
    await gate.reached;
    f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
    let stopped = false;
    const stopping = f.service.stop(START_USER, 'disabled').then(() => {
      stopped = true;
    });
    expect(signal?.aborted).toBe(true);
    let closed = false;
    const closing = f.service.close().then(() => {
      closed = true;
    });
    await expect(f.service.stop('mnopqrstuvwx', 'admin')).rejects.toThrow(
      'Instance service unavailable',
    );
    await expect(f.service.start(START_USER)).rejects.toThrow('Instance service unavailable');
    expect(stopped).toBe(false);
    expect(closed).toBe(false);
    expect(f.database.open).toBe(true);
    gate.release();
    await start;
    await stopping;
    await closing;
    expect(f.database.prepare('SELECT * FROM instances').all()).toEqual([]);
    expect(
      f.database.prepare("SELECT * FROM audit_events WHERE event_type='instance.stopped'").all(),
    ).toEqual([]);
    expect(f.daemon.requests.some(({ path }) => path.includes('follow=true'))).toBe(false);
    expect(f.database.open).toBe(true);
  } finally {
    gate.release();
    await f.close();
  }
});

it('a canceled queued startup cannot acknowledge no-row retirement before its held predecessor settles', async () => {
  const f = await fixture();
  const gate = startupBarrier();
  try {
    configure(f.database);
    await f.owner.startUserContainer(f.input);
    f.database.prepare("UPDATE instances SET status='running',dsh_cookie=?").run(RECONCILE_COOKIE);
    f.beforeRequest(async (method, path) => {
      if (method === 'GET' && path === `/containers/${START_CONTAINER}/json`) await gate.hold();
      return undefined;
    });
    const predecessor = Promise.allSettled([f.service.reconcile()]);
    await gate.reached;
    const start = expect(f.service.start(START_USER)).rejects.toThrow('Instance operation failed');
    f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
    f.database.prepare('DELETE FROM instances WHERE user_id=?').run(START_USER);
    let stopped = false;
    const stop = f.service.stop(START_USER, 'disabled').then(() => {
      stopped = true;
    });
    await start;
    expect(stopped).toBe(false);
    gate.release();
    await predecessor;
    await stop;
    expect(f.daemon.requests.some(({ path }) => path.includes('follow=true'))).toBe(false);
    expect(
      f.database.prepare("SELECT * FROM audit_events WHERE event_type='instance.stopped'").all(),
    ).toEqual([]);
  } finally {
    gate.release();
    await f.close();
  }
});

it('disabled retirement does not adopt an account reactivated while canceled startup settles', async () => {
  const f = await fixture();
  const gate = startupBarrier();
  try {
    configure(f.database);
    f.beforeRequest(async (method, path) => {
      if (method === 'GET' && path.startsWith('/images/')) await gate.hold();
      return undefined;
    });
    const start = expect(f.service.start(START_USER)).rejects.toThrow('Instance operation failed');
    await gate.reached;
    f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
    const stop = expect(f.service.stop(START_USER, 'disabled')).rejects.toThrow(
      'User container retirement failed',
    );
    f.database.prepare("UPDATE users SET status='active' WHERE id=?").run(START_USER);
    gate.release();
    await start;
    await stop;
    expect(f.database.prepare('SELECT status FROM users WHERE id=?').get(START_USER)).toEqual({
      status: 'active',
    });
    expect(f.database.prepare('SELECT * FROM instances').all()).toEqual([]);
    expect(f.database.prepare('SELECT * FROM audit_events').all()).toEqual([]);
  } finally {
    gate.release();
    await f.close();
  }
});

it('disabled stop cancels owned readiness logs immediately rather than waiting the sixty-second deadline', async () => {
  const logs = heldReadinessLogs('private-canceled-readiness-cookie');
  const f = await fixture(logs.adapt);
  try {
    configure(f.database);
    expect(await f.service.start(START_USER)).toEqual({ status: 'starting', reason: 'starting' });
    await logs.entered;
    f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
    await f.service.stop(START_USER, 'disabled');
    expect(logs.aborted).toBe(true);
    expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(
      f.database.prepare('SELECT status,container_id,dsh_cookie FROM instances').get(),
    ).toEqual({ status: 'stopped', container_id: null, dsh_cookie: null });
    expect(
      f.database.prepare("SELECT * FROM audit_events WHERE event_type='instance.ready'").all(),
    ).toEqual([]);
    expect(
      f.database
        .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
        .all(),
    ).toEqual([{ details: '{"reason":"disabled"}' }]);
    expect(JSON.stringify(f.database.prepare('SELECT * FROM audit_events').all())).not.toContain(
      'private-canceled-readiness-cookie',
    );
  } finally {
    logs.release();
    await f.close();
  }
});

it('close waits a held physical stop with no startup flight and rejects further stop admission', async () => {
  const f = await fixture();
  const gate = startupBarrier();
  try {
    await f.owner.startUserContainer(f.input);
    f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
    f.beforeRequest(async (method, path) => {
      if (method === 'POST' && path === `/containers/${START_CONTAINER}/stop?t=1`)
        await gate.hold();
      return undefined;
    });
    const stop = f.service.stop(START_USER, 'disabled');
    await gate.reached;
    let closed = false;
    const closing = f.service.close().then(() => {
      closed = true;
    });
    await expect(f.service.stop('mnopqrstuvwx', 'admin')).rejects.toThrow(
      'Instance service unavailable',
    );
    expect(closed).toBe(false);
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    expect(f.database.open).toBe(true);
    gate.release();
    await stop;
    await closing;
    expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(
      f.database
        .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
        .all(),
    ).toEqual([{ details: '{"reason":"disabled"}' }]);
    expect(f.database.open).toBe(true);
  } finally {
    gate.release();
    await f.close();
  }
});
