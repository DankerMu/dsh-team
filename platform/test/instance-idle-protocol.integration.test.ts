import { expect, it } from 'vitest';
import { createSession } from '../src/auth/index.ts';
import { START_CONTAINER, START_USER } from './container-start-fixture.ts';
import {
  activityUpgradeRequest,
  connectActivityPeer,
  observeActivity,
} from './gateway-activity-fixture.ts';
import { withIdleInstance } from './instance-idle-fixture.ts';

it.each([
  'unknown',
  'rpc-mismatch',
  'bad-envelope',
  'bad-running',
  'missing-items',
  'malformed',
  'partial',
  'oversize',
  'oversize-header',
  'deadline',
  'reset',
] as const)(
  'real HTTP %s never authorizes retirement or carries an old idle interval through recovery',
  async (mode) => {
    await withIdleInstance(async (f) => {
      await f.service.checkIdle(f.getActivity);
      f.setNow(660_000);
      f.control.tasks = mode;
      await f.service.checkIdle(f.getActivity);
      expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
      expect(
        f.database.prepare("SELECT * FROM audit_events WHERE event_type='instance.stopped'").all(),
      ).toEqual([]);
      f.control.tasks = 'idle';
      f.setNow(900_000);
      await f.service.checkIdle(f.getActivity);
      expect(f.service.status(START_USER)).toEqual({ status: 'running', reason: null });
      f.setNow(960_000);
      await f.service.checkIdle(f.getActivity);
      expect(f.service.status(START_USER)).toEqual({ status: 'stopped', reason: 'stopped' });
    });
  },
);

it('a live authenticated gateway connection prevents idle retirement and its release starts a fresh interval', async () => {
  await withIdleInstance(async (f) => {
    if (f.app === undefined) throw new Error('Missing actual application');
    const port = f.app.addresses()[0]?.port;
    if (port === undefined) throw new Error('Missing application port');
    const cookie = `platform_session=${createSession(f.database, START_USER, 600_000)}`;
    const peer = await connectActivityPeer(port);
    try {
      peer.socket.write(activityUpgradeRequest(port, cookie, 'http://instance.example'));
      expect((await peer.read('\r\n\r\n')).toString().startsWith('HTTP/1.1 101 ')).toBe(true);
      expect(f.getActivity(START_USER).liveCount).toBe(1);
      await f.service.checkIdle(f.getActivity);
      f.setNow(900_000);
      await f.service.checkIdle(f.getActivity);
      expect(f.service.status(START_USER)).toEqual({ status: 'running', reason: null });
      peer.socket.destroy();
      await peer.closed;
      await observeActivity(() => f.getActivity(START_USER).liveCount === 0);
      await f.service.checkIdle(f.getActivity);
      expect(f.service.status(START_USER)).toEqual({ status: 'running', reason: null });
      f.setNow(960_000);
      await f.service.checkIdle(f.getActivity);
      expect(f.service.status(START_USER)).toEqual({ status: 'stopped', reason: 'stopped' });
    } finally {
      peer.socket.destroy();
      await peer.closed;
    }
  }, true);
});
