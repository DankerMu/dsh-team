import { expect, it, vi } from 'vitest';
import { writeSettings } from '../src/db/index.ts';
import { START_CONTAINER, START_USER, startupBarrier } from './container-start-fixture.ts';
import { RECONCILE_COOKIE } from './container-reconcile-fixture.ts';
import { observeActivity } from './gateway-activity-fixture.ts';
import { withIdleInstance, IDLE_SIBLING } from './instance-idle-fixture.ts';

it.each(['busy', 'unknown'] as const)(
  'requires a fresh full interval after %s tasks become known idle',
  async (tasks) => {
    await withIdleInstance(async (f) => {
      await f.service.checkIdle(f.getActivity);
      f.setNow(660_000);
      f.control.tasks = tasks;
      await f.service.checkIdle(f.getActivity);
      expect(f.service.status(START_USER)).toEqual({ status: 'running', reason: null });
      f.control.tasks = 'idle';
      f.setNow(900_000);
      await f.service.checkIdle(f.getActivity);
      f.setNow(959_999);
      await f.service.checkIdle(f.getActivity);
      expect(f.service.status(START_USER)).toEqual({ status: 'running', reason: null });
      f.setNow(960_000);
      await f.service.checkIdle(f.getActivity);
      expect(f.service.status(START_USER)).toEqual({ status: 'stopped', reason: 'stopped' });
      expect(
        f.database
          .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
          .all(),
      ).toEqual([{ details: '{"reason":"idle"}' }]);
    });
  },
);

it.each([
  'same-time-activity',
  'explicit-start',
  'replacement',
  'backwards-clock',
  'settings',
] as const)('invalidates a due observation when %s changes during the real RPC', async (change) => {
  await withIdleInstance(async (f) => {
    await f.service.checkIdle(f.getActivity);
    f.setNow(660_000);
    const gate = startupBarrier();
    f.control.probe = gate;
    const checking = f.service.checkIdle(f.getActivity);
    await gate.reached;
    let starting: Promise<unknown> | undefined;
    if (change === 'same-time-activity') {
      f.service.recordActivity(START_USER, 660_000);
      f.service.recordActivity(START_USER, 660_000);
    } else if (change === 'explicit-start') {
      writeSettings(f.database, { modelApiKey: '' });
      starting = f.service.start(START_USER);
    } else if (change === 'replacement') {
      f.database
        .prepare('UPDATE instances SET last_started_at=777 WHERE user_id=?')
        .run(START_USER);
    } else if (change === 'backwards-clock') f.setNow(599_999);
    else writeSettings(f.database, { idleMinutes: 30 });
    gate.release();
    f.control.probe = undefined;
    await checking;
    await starting;
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    expect(
      f.database
        .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
        .all(),
    ).toEqual([]);
    expect(f.daemon.requests.filter(({ method }) => method === 'DELETE')).toEqual([]);
  });
});

it('rereads adjustable idle minutes and cannot overflow the settings domain into an early stop', async () => {
  await withIdleInstance(async (f) => {
    writeSettings(f.database, { idleMinutes: Number.MAX_SAFE_INTEGER });
    await f.service.checkIdle(f.getActivity);
    f.setNow(900_000);
    await f.service.checkIdle(f.getActivity);
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    writeSettings(f.database, { idleMinutes: 5 });
    await f.service.checkIdle(f.getActivity);
    expect(f.service.status(START_USER)).toEqual({ status: 'stopped', reason: 'stopped' });
  });
});

it('keeps lookup routable but fences only the admitted retirement and orders a later start in the original FIFO', async () => {
  await withIdleInstance(async (f) => {
    const stop = startupBarrier();
    const probe = startupBarrier();
    try {
      await f.service.checkIdle(f.getActivity);
      f.setNow(660_000);
      f.control.probe = probe;
      f.holdEngine((method, path) =>
        method === 'POST' && path.startsWith(`/containers/${START_CONTAINER}/stop?`)
          ? stop.hold()
          : undefined,
      );
      const checking = f.service.checkIdle(f.getActivity);
      await probe.reached;
      expect(f.service.resolveUpstream(START_USER).outcome).toBe('running');
      probe.release();
      f.control.probe = undefined;
      await stop.reached;
      expect(f.service.resolveUpstream(START_USER)).toEqual({ outcome: 'starting' });
      expect(
        f.database.prepare('SELECT status FROM instances WHERE user_id=?').get(START_USER),
      ).toEqual({ status: 'running' });
      writeSettings(f.database, { modelApiKey: '' });
      let settled = false;
      const starting = f.service.start(START_USER).then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      stop.release();
      await checking;
      expect(await starting).toEqual({ status: 'unconfigured', reason: 'unconfigured' });
      expect(f.service.resolveUpstream(START_USER)).toEqual({ outcome: 'unconfigured' });
      expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
    } finally {
      probe.release();
      stop.release();
    }
  });
});

it('a held same-user queue does not prevent independent users from reaching exact idle retirement', async () => {
  await withIdleInstance(async (f) => {
    f.seedSibling();
    await f.service.checkIdle(f.getActivity);
    const queue = startupBarrier();
    f.holdEngine((method, path) =>
      method === 'GET' && path === `/containers/${START_CONTAINER}/json` ? queue.hold() : undefined,
    );
    const starting = f.service.start(START_USER);
    try {
      await queue.reached;
      f.setNow(660_000);
      const checking = f.service.checkIdle(f.getActivity);
      await observeActivity(() => f.service.status(IDLE_SIBLING).status === 'stopped');
      expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
      queue.release();
      await starting;
      await checking;
      expect(f.service.status(START_USER)).toEqual({ status: 'running', reason: null });
    } finally {
      queue.release();
      await starting;
    }
  });
});

it('preserves canonical failed-stop state and releases the transient resolver fence', async () => {
  await withIdleInstance(async (f) => {
    await f.service.checkIdle(f.getActivity);
    f.setNow(660_000);
    f.daemon.overrides.set(`POST /containers/${START_CONTAINER}/stop?t=1`, { status: 500 });
    await expect(f.service.checkIdle(f.getActivity)).rejects.toThrow('Idle instance check failed');
    expect(f.service.resolveUpstream(START_USER).outcome).toBe('running');
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    expect(
      f.database.prepare("SELECT * FROM audit_events WHERE event_type='instance.stopped'").all(),
    ).toEqual([]);
  });
});

it('application minute ticks do not overlap and retire only after a complete known-idle interval', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    await withIdleInstance(async (f) => {
      const gate = startupBarrier();
      f.control.probe = gate;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(f.control.probes).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await gate.reached;
      const first = f.service.checkIdle(f.getActivity);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.control.probes).toBe(1);
      gate.release();
      f.control.probe = undefined;
      await first;
      expect(f.service.status(START_USER)).toEqual({ status: 'running', reason: null });
      f.setNow(660_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await observeActivity(() => f.service.status(START_USER).status === 'stopped');
      expect(
        f.database
          .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
          .all(),
      ).toEqual([{ details: '{"reason":"idle"}' }]);
    }, true);
  } finally {
    vi.useRealTimers();
  }
});

it('application close cancels held probes and closes its listener before releasing SQLite', async () => {
  await withIdleInstance(async (f) => {
    if (f.app === undefined || f.base === undefined) throw new Error('Missing actual application');
    const gate = startupBarrier();
    f.control.probe = gate;
    const checking = f.service.checkIdle(f.getActivity);
    await gate.reached;
    await f.app.close();
    await checking;
    expect(f.app.server.listening).toBe(false);
    expect(f.database.open).toBe(false);
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    await expect(f.service.checkIdle(f.getActivity)).rejects.toThrow(
      'Instance service unavailable',
    );
    gate.release();
    f.control.probe = undefined;
  }, true);
});

it('application close fences the listener immediately while an admitted bounded stop drains before SQLite', async () => {
  await withIdleInstance(async (f) => {
    if (f.app === undefined) throw new Error('Missing actual application');
    await f.service.checkIdle(f.getActivity);
    f.setNow(660_000);
    const stop = startupBarrier();
    f.holdEngine((method, path) =>
      method === 'POST' && path.startsWith(`/containers/${START_CONTAINER}/stop?`)
        ? stop.hold()
        : undefined,
    );
    const checking = f.service.checkIdle(f.getActivity);
    await stop.reached;
    const closing = f.app.close();
    await observeActivity(() => f.app?.server.listening === false);
    expect(f.database.open).toBe(true);
    stop.release();
    await checking;
    await closing;
    expect(f.database.open).toBe(false);
    expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
  }, true);
});

it('bounded original-FIFO waiters cannot occupy every traversal worker indefinitely or accumulate a second idle queue', async () => {
  await withIdleInstance(async (f) => {
    const held = [START_CONTAINER, 'c'.repeat(64), 'd'.repeat(64), 'f'.repeat(64)];
    for (const [index, userId] of ['bcdefghijklm', 'cdefghijklmn', 'defghijklmno'].entries()) {
      const id = held[index + 1];
      if (id === undefined) throw new Error('Missing owned queued identity');
      f.seedUser(userId, id);
    }
    const target = 'zzzzzzzzzzzz';
    const targetId = '9'.repeat(64);
    f.seedUser(target, targetId);
    f.database.prepare('UPDATE instances SET dsh_cookie=?').run(RECONCILE_COOKIE);
    await f.service.checkIdle(f.getActivity);
    const gates = new Map(held.map((id) => [id, startupBarrier()]));
    f.holdEngine((method, path) => {
      if (method !== 'GET' || !path.startsWith('/containers/') || !path.endsWith('/json'))
        return undefined;
      return gates.get(path.slice('/containers/'.length, -'/json'.length))?.hold();
    });
    const reconciling = f.service.reconcile();
    void reconciling.catch(() => undefined);
    try {
      await Promise.all([...gates.values()].map((gate) => gate.reached));
      f.setNow(660_000);
      await f.service.checkIdle(f.getActivity);
      expect(f.service.status(target)).toEqual({ status: 'stopped', reason: 'stopped' });
      expect(f.daemon.containers.has(targetId)).toBe(false);
      for (const id of held) expect(f.daemon.containers.get(id)?.State.Running).toBe(true);
      // Existing canceled owner slots remain pinned: repeated sweeps cannot append new waiters.
      await f.service.checkIdle(f.getActivity);
      expect(
        f.database
          .prepare("SELECT target,details FROM audit_events WHERE event_type='instance.stopped'")
          .all(),
      ).toEqual([{ target, details: '{"reason":"idle"}' }]);
    } finally {
      for (const gate of gates.values()) gate.release();
      await reconciling;
    }
    for (const id of held) expect(f.daemon.containers.get(id)?.State.Running).toBe(true);
    expect(
      f.database
        .prepare("SELECT target,details FROM audit_events WHERE event_type='instance.stopped'")
        .all(),
    ).toEqual([{ target, details: '{"reason":"idle"}' }]);
  });
  // A real five-second per-user queue deadline plus original FIFO/Engine cleanup needs margin.
}, 20_000);
