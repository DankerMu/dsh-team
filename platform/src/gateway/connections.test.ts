import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { createGatewayConnections } from './connections.ts';

const ALICE = { userId: 'alice', token: 'alice-session' };
const BOB = { userId: 'bob', token: 'bob-session' };

it('closes only the selected user cohort and allows later connections', async () => {
  const connections = createGatewayConnections();
  const first = new PassThrough();
  const second = new PassThrough();
  const sibling = new PassThrough();
  connections.track(ALICE, first);
  connections.track(ALICE, second);
  connections.track(BOB, sibling);

  await connections.disconnectUser('alice');

  expect(first.closed).toBe(true);
  expect(second.closed).toBe(true);
  expect(sibling.destroyed).toBe(false);
  const received = once(sibling, 'data');
  sibling.write('still live');
  expect((await received)[0]).toEqual(Buffer.from('still live'));
  const later = new PassThrough();
  connections.track(ALICE, later);
  await connections.disconnectUser('unknown');
  expect(later.destroyed).toBe(false);
  await connections.disconnectUser('alice');
  expect(later.closed).toBe(true);
  await connections.disconnectUser('alice');
  await connections.close();
  expect(sibling.closed).toBe(true);
});

it('does not let released ownership close a reassigned or completed resource', async () => {
  const connections = createGatewayConnections();
  const reassigned = new PassThrough();
  const completed = new PassThrough();
  const old = connections.track(ALICE, reassigned);
  connections.track(BOB, reassigned);
  old();
  const release = connections.track(ALICE, completed);
  release();
  release();

  await connections.disconnectUser('alice');

  expect(reassigned.destroyed).toBe(false);
  expect(completed.destroyed).toBe(false);
  await connections.close();
  expect(reassigned.closed).toBe(true);
  expect(completed.destroyed).toBe(false);
  completed.destroy();
  await once(completed, 'close');
});

it('keeps registrations made during old-cohort close outside the captured disconnect', async () => {
  const connections = createGatewayConnections();
  const first = new PassThrough();
  const later = new PassThrough();
  connections.track(ALICE, first);
  first.prependOnceListener('close', () => {
    connections.track(ALICE, later);
  });

  await connections.disconnectUser('alice');

  expect(first.closed).toBe(true);
  expect(later.destroyed).toBe(false);
  await connections.disconnectUser('alice');
  expect(later.closed).toBe(true);
});

it('owns anonymous shutdown resources and refuses late registration after close', async () => {
  const connections = createGatewayConnections();
  const anonymous = new PassThrough();
  const closed = new PassThrough();
  connections.track(undefined, anonymous);
  closed.destroy();
  await once(closed, 'close');
  connections.track(ALICE, closed);

  await connections.close();

  expect(anonymous.closed).toBe(true);
  const late = new PassThrough();
  const finished = once(late, 'close');
  connections.track(ALICE, late);
  await finished;
  expect(late.closed).toBe(true);
  await connections.close();
});

it('does not share a user cohort between registry owners', async () => {
  const first = createGatewayConnections();
  const second = createGatewayConnections();
  const connection = new PassThrough();
  second.track(ALICE, connection);

  await first.disconnectUser('alice');
  await first.close();

  expect(connection.destroyed).toBe(false);
  await second.close();
  expect(connection.closed).toBe(true);
});

it('releases a finished HTTP-style resource without closing its transport lifetime', async () => {
  const connections = createGatewayConnections();
  const response = new PassThrough();
  connections.track(ALICE, response, true);
  const finished = once(response, 'finish');
  response.end('complete');
  await finished;

  await connections.disconnectUser('alice');
  await connections.close();

  expect(response.destroyed).toBe(false);
  const data = once(response, 'data');
  response.resume();
  expect((await data)[0]).toEqual(Buffer.from('complete'));
  if (!response.closed) await once(response, 'close');
});

it('revalidates shared session ownership once and releases reassigned and finished resources', async () => {
  const connections = createGatewayConnections();
  const first = new PassThrough();
  const second = new PassThrough();
  const live = new PassThrough();
  const completed = new PassThrough();
  const replacement = { userId: 'alice', token: 'replacement-session' };
  connections.track(ALICE, first);
  connections.track(ALICE, second);
  const releaseOld = connections.track(ALICE, live);
  connections.track(replacement, live);
  releaseOld();
  connections.track(ALICE, completed, true);
  completed.end();
  await once(completed, 'finish');
  const firstClosed = once(first, 'close');
  const secondClosed = once(second, 'close');
  const checked: string[] = [];

  connections.revalidateSessions((_userId, token) => {
    checked.push(token);
    return token === replacement.token;
  });
  await Promise.all([firstClosed, secondClosed]);

  expect(checked).toEqual([ALICE.token, replacement.token]);
  expect(completed.destroyed).toBe(false);
  expect(live.destroyed).toBe(false);
  const remaining: string[] = [];
  connections.revalidateSessions((_userId, token) => {
    remaining.push(token);
    return true;
  });
  expect(remaining).toEqual([replacement.token]);
  await connections.close();
  connections.revalidateSessions(() => {
    throw new Error('Closed ownership must not retain sessions');
  });
  completed.destroy();
  await once(completed, 'close');
});
