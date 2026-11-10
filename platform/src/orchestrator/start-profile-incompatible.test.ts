import { rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import type { DatabaseHandle } from '../db/index.ts';
import {
  startupOwnerFixture,
  START_CONTAINER,
  START_HELPER,
  START_USER,
} from '../../test/container-start-fixture.ts';
import type { StartupRequest } from '../../test/container-start-fixture.ts';

// The managed composition stage of `startUserContainer`, before any network or container exists.
const roots: string[] = [];
const databases: DatabaseHandle[] = [];
afterEach(async () => {
  for (const handle of databases.splice(0)) handle.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const INCOMPATIBLE = '{"profileIncompatible":true}';
const LAST_ERROR = 'profile-incompatible\nManaged composition rejected: incompatible DSH profile';
const EMAIL = `${START_USER}@example.test`;

async function fixture(composition: string) {
  const context = await startupOwnerFixture();
  roots.push(context.root);
  databases.push(context.database);
  context.daemon.setComposition(composition);
  const { database } = context;
  return {
    ...context,
    rows: () => database.prepare('SELECT * FROM instances').all(),
    instance: () =>
      database.prepare('SELECT status, container_id, last_error, dsh_cookie FROM instances').all(),
    audits: () =>
      database.prepare('SELECT event_type, target, target_email, details FROM audit_events').all(),
    // Rejected start: the error is the unchanged closed stage failure, nothing beyond the helper.
    rejected: async (pattern = /^Container startup failed during managed composition$/) => {
      const error: unknown = await context.owner
        .startUserContainer(context.input)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(pattern);
      expect(JSON.stringify(error)).not.toContain('profile-incompatible');
      expect(beyondHelper(context.daemon.requests)).toEqual([]);
      expect(context.daemon.containers.has(START_CONTAINER)).toBe(false);
    },
  };
}

function beyondHelper(requests: readonly StartupRequest[]): string[] {
  return requests
    .map(({ method, path }) => `${method} ${path}`)
    .filter((request) => /networks\/create|name=dsh-team-u-|\/connect/.test(request));
}

const onHelperLogs = (
  daemon: Awaited<ReturnType<typeof startupOwnerFixture>>['daemon'],
  action: () => void,
) => {
  daemon.beforeRequest((request) => {
    if (request.path.startsWith(`/containers/${START_HELPER}/logs?`)) action();
  });
};

it('persists an error row without a container and one coded audit before any network exists', async () => {
  const { instance, audits, rejected, daemon } = await fixture(INCOMPATIBLE);

  await rejected();

  expect(instance()).toEqual([
    { status: 'error', container_id: null, last_error: LAST_ERROR, dsh_cookie: null },
  ]);
  expect(audits()).toEqual([
    {
      event_type: 'instance.start-failed',
      target: START_USER,
      target_email: EMAIL,
      details: '{"code":"profile-incompatible"}',
    },
  ]);
  // The helper itself is still cleaned up as for every composition outcome.
  expect(
    daemon.requests.filter((request) => request.method === 'DELETE').map(({ path }) => path),
  ).toEqual([`/containers/${START_HELPER}?force=true`]);
});

it('overwrites a stopped container-less row and a later compatible start takes the error row', async () => {
  const { database, instance, audits, rejected, daemon, owner, input } =
    await fixture(INCOMPATIBLE);
  database
    .prepare("INSERT INTO instances(user_id,status,last_error) VALUES (?, 'stopped', 'earlier')")
    .run(START_USER);

  await rejected();
  expect(instance()).toEqual([
    { status: 'error', container_id: null, last_error: LAST_ERROR, dsh_cookie: null },
  ]);

  daemon.setComposition();
  expect(await owner.startUserContainer(input)).toMatchObject({
    outcome: 'starting',
    containerId: START_CONTAINER,
  });
  expect(instance()).toEqual([
    { status: 'starting', container_id: START_CONTAINER, last_error: null, dsh_cookie: null },
  ]);
  expect(audits().map((event) => (event as { event_type: string }).event_type)).toEqual([
    'instance.start-failed',
    'instance.created',
    'instance.started',
  ]);
});

it('records the rejection even when the helper cleanup then fails, keeping that failure category', async () => {
  const { daemon, instance, audits, rejected } = await fixture(INCOMPATIBLE);
  onHelperLogs(daemon, () => {
    const helper = daemon.containers.get(START_HELPER);
    if (helper) helper.Config.Labels = { 'dsh-team.user': 'foreign-user' };
  });

  await rejected(
    /^Container startup failed during managed composition; managed composition cleanup failed$/,
  );

  expect(instance()).toEqual([
    { status: 'error', container_id: null, last_error: LAST_ERROR, dsh_cookie: null },
  ]);
  expect(audits()).toHaveLength(1);
});

it.each([
  ['gains a container', `UPDATE instances SET container_id = '${'f'.repeat(64)}'`],
  ['becomes starting', "UPDATE instances SET status = 'starting'"],
  ['becomes running', "UPDATE instances SET status = 'running'"],
])('writes neither row nor audit when the row %s during composition', async (_label, change) => {
  const { database, daemon, rows, audits, rejected } = await fixture(INCOMPATIBLE);
  database
    .prepare("INSERT INTO instances(user_id,status,container_id) VALUES (?, 'stopped', NULL)")
    .run(START_USER);
  let before: unknown;
  onHelperLogs(daemon, () => {
    database.prepare(change).run();
    before = rows();
  });

  await rejected();

  expect(before).toBeDefined();
  expect(rows()).toEqual(before);
  expect(audits()).toEqual([]);
});

it.each([
  ['changed email', `UPDATE users SET email = 'renamed@example.test' WHERE id = '${START_USER}'`],
  ['disabled', `UPDATE users SET status = 'disabled' WHERE id = '${START_USER}'`],
])('writes neither row nor audit when the account is %s during composition', async (_l, change) => {
  const { database, daemon, rows, audits, rejected } = await fixture(INCOMPATIBLE);
  onHelperLogs(daemon, () => database.prepare(change).run());

  await rejected();

  expect(rows()).toEqual([]);
  expect(audits()).toEqual([]);
});

it.each([
  ['invalid JSON', 'invalid-json'],
  ['a short-circuit with an extra key', '{"profileIncompatible":true,"skippedBundles":[]}'],
  [
    'a non-empty skipped bundle list',
    JSON.stringify({ skippedBundles: [{ packageName: '@deepseek-ai/dsh-base', reason: 'x' }] }),
  ],
])('leaves the row and audit untouched for %s', async (_label, composition) => {
  const { database, rows, audits, rejected } = await fixture(composition);
  database
    .prepare("INSERT INTO instances(user_id,status,last_error) VALUES (?, 'stopped', 'earlier')")
    .run(START_USER);
  const before = rows();

  await rejected();

  expect(rows()).toEqual(before);
  expect(audits()).toEqual([]);
});
