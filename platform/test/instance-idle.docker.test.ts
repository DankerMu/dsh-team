import { randomUUID } from 'node:crypto';
import { arch, platform } from 'node:os';
import { expect, it } from 'vitest';
import { writeSettings } from '../src/db/index.ts';
import { inspect, record } from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import {
  activityUpgradeRequest,
  connectActivityPeer,
  observeActivity,
} from './gateway-activity-fixture.ts';
import { withDockerIdleInstance, waitDockerIdle } from './instance-idle-docker-fixture.ts';
import type { DockerIdleContext } from './instance-idle-docker-fixture.ts';

function expectIdleRetirement(f: DockerIdleContext): void {
  expect(f.service.status(f.user.id)).toEqual({ status: 'stopped', reason: 'stopped' });
  expect(
    isAbsentResource(
      f.lifecycle.command(['container', 'inspect', f.containerId], 15_000),
      'container',
      f.containerId,
    ),
  ).toBe(true);
  expect(
    f.database
      .prepare(
        "SELECT event_type,target,target_email,details FROM audit_events WHERE event_type='instance.stopped' ORDER BY id",
      )
      .all(),
  ).toEqual([
    {
      event_type: 'instance.stopped',
      target: f.user.id,
      target_email: 'idle-docker@example.test',
      details: '{"reason":"idle"}',
    },
  ]);
  f.verifyVolumes();
}

it('real DSH without connections or tasks is retired only after a full idle interval with retained home and work volumes', async () => {
  expect(platform()).toBe('linux');
  expect(arch()).toBe('x64');
  await withDockerIdleInstance(async (f) => {
    const items = f.rpc('session/list', { _request: {} }).items;
    if (!Array.isArray(items)) throw new Error('Missing released complete Session list');
    for (const item of items) expect(record(item).running).toBe(false);
    expect(f.app.getUserActivity(f.user.id).liveCount).toBe(0);
    const began = Date.now();
    await f.checkIdle();
    f.setNow(began + 59_999);
    await f.checkIdle();
    expect(record(inspect(f.lifecycle, f.containerId).State).Running).toBe(true);
    f.setNow(began + 60_000);
    await f.checkIdle();
    expectIdleRetirement(f);
  });
});

it('an open authenticated page connection to real DSH prevents retirement beyond the configured idle interval', async () => {
  await withDockerIdleInstance(async (f) => {
    const port = f.app.addresses()[0]?.port;
    if (port === undefined) throw new Error('Missing actual platform listener');
    const peer = await connectActivityPeer(port);
    try {
      peer.socket.write(
        activityUpgradeRequest(port, f.user.cookie, 'http://instance.example').replace(
          '/activity-ws',
          '/api/remote.mux',
        ),
      );
      expect((await peer.read('\r\n\r\n')).toString().startsWith('HTTP/1.1 101 ')).toBe(true);
      expect(f.app.getUserActivity(f.user.id).liveCount).toBe(1);
      const began = Date.now();
      await f.checkIdle();
      f.setNow(began + 5 * 60_000);
      await f.checkIdle();
      expect(record(inspect(f.lifecycle, f.containerId).State).Running).toBe(true);
      expect(
        f.database
          .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
          .all(),
      ).toEqual([]);
      peer.socket.destroy();
      await peer.closed;
      await observeActivity(() => f.app.getUserActivity(f.user.id).liveCount === 0);
      await f.checkIdle();
      expect(f.service.status(f.user.id)).toEqual({ status: 'running', reason: null });
      f.setNow(began + 6 * 60_000);
      await f.checkIdle();
      expectIdleRetirement(f);
    } finally {
      peer.socket.destroy();
      await peer.closed;
    }
  });
});

it('a real held Agent turn in the same Web instance survives without connections and completion starts a fresh idle interval', async () => {
  await withDockerIdleInstance(async (f) => {
    const created = f.rpc('session/create', {
      request: { cwd: '/data/work', agentPreset: 'standard' },
    });
    if (typeof created.sessionId !== 'string') throw new Error('Missing real Session');
    const sessionId = created.sessionId;
    const nonce = randomUUID();
    f.control({ op: 'adopt', sessionId });
    const running = () => {
      const items = f.rpc('session/list', { _request: {} }).items;
      if (!Array.isArray(items)) throw new Error('Missing released task list');
      const item: unknown = items.find((value: unknown) => record(value).sessionId === sessionId);
      const status = record(item).running;
      if (typeof status !== 'boolean') throw new Error('Missing strict real running state');
      return status;
    };
    await waitDockerIdle(() => !running());
    const began = Date.now();
    await f.checkIdle();
    let released = false;
    try {
      f.control({ op: 'hold', sessionId, nonce });
      await waitDockerIdle(() => running());
      const holds = f.control({ op: 'status' }).holds;
      if (!Array.isArray(holds)) throw new Error('Missing real adapter observations');
      expect(holds.map((value: unknown) => record(value))).toContainEqual({
        nonce,
        sessionId,
        entered: true,
        completed: false,
        aborted: false,
      });
      expect(f.app.getUserActivity(f.user.id).liveCount).toBe(0);
      f.setNow(began + 5 * 60_000);
      await f.checkIdle();
      expect(running()).toBe(true);
      expect(record(inspect(f.lifecycle, f.containerId).State).Running).toBe(true);
      f.control({ op: 'release', nonce });
      released = true;
      await waitDockerIdle(() => !running());
      await f.checkIdle();
      f.setNow(began + 6 * 60_000 - 1);
      await f.checkIdle();
      expect(f.service.status(f.user.id)).toEqual({ status: 'running', reason: null });
      f.setNow(began + 6 * 60_000);
      await f.checkIdle();
      expectIdleRetirement(f);
    } finally {
      if (!released) f.control({ op: 'release', nonce });
    }
  });
});

it('changing idle minutes from thirty to five affects the next real DSH decision without restarting the platform', async () => {
  await withDockerIdleInstance(async (f) => {
    writeSettings(f.database, { idleMinutes: 30 });
    const began = Date.now();
    await f.checkIdle();
    f.setNow(began + 5 * 60_000);
    await f.checkIdle();
    expect(record(inspect(f.lifecycle, f.containerId).State).Running).toBe(true);
    writeSettings(f.database, { idleMinutes: 5 });
    await f.checkIdle();
    expectIdleRetirement(f);
  });
});
