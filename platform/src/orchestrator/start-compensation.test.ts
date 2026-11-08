import { rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import type { DatabaseHandle } from '../db/index.ts';
import {
  startupOwnerFixture,
  START_CONTAINER,
  START_NETWORK,
  START_USER,
} from '../../test/container-start-fixture.ts';

const roots: string[] = [];
const databases: DatabaseHandle[] = [];
afterEach(async () => {
  for (const handle of databases.splice(0)) handle.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const START_LOGS = `/containers/${START_CONTAINER}/logs?stdout=true&stderr=true&follow=false&tail=1000`;
const COMPENSATED =
  'Platform attachment/startup failed; started container and owned network removed';

function stderrFrame(text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 2;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

async function compensatedWithLogs(logs: { status: number; bytes?: Buffer }) {
  const { daemon, input, owner, database, root } = await startupOwnerFixture();
  roots.push(root);
  databases.push(database);
  daemon.actualAddresses.set(START_CONTAINER, '172.30.0.5');
  daemon.overrides.set(`GET ${START_LOGS}`, logs);

  await expect(owner.startUserContainer(input)).rejects.toThrow(
    /^Container startup failed during .*; started container and owned network removed$/,
  );

  const paths = daemon.requests.map(({ method, path }) => `${method} ${path}`);
  const read = paths.indexOf(`GET ${START_LOGS}`);
  expect(read).toBeGreaterThan(paths.indexOf(`POST /containers/${START_CONTAINER}/start`));
  expect(read).toBeLessThan(paths.indexOf(`POST /containers/${START_CONTAINER}/stop?t=1`));
  expect(paths.filter((path) => path === `GET ${START_LOGS}`)).toHaveLength(1);
  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(daemon.networks.has(START_NETWORK)).toBe(false);
  return {
    row: database
      .prepare('SELECT status, last_error FROM instances WHERE user_id = ?')
      .get(START_USER),
    audits: database
      .prepare("SELECT details FROM audit_events WHERE event_type = 'instance.start-failed'")
      .all(),
  };
}

it.each([
  'dsh: skipping profile bundle "@deepseek-ai/dsh-base": incompatible with dsh 0.2.1-rc.2\n',
  'harmless boot line\ndsh: disabling profile plugin @dsh-team/office-agents: engines\n',
])(
  'compensation reads the started container log before removal and records profile-incompatible for %j',
  async (text) => {
    const { row, audits } = await compensatedWithLogs({ status: 200, bytes: stderrFrame(text) });

    expect(row).toEqual({ status: 'error', last_error: `profile-incompatible\n${COMPENSATED}` });
    expect(audits).toEqual([{ details: '{"code":"profile-incompatible"}' }]);
  },
);

it.each([
  [
    'an unrelated plugin failure log',
    { status: 200, bytes: stderrFrame('plugin tree failed to load\n') },
  ],
  ['an unreadable log', { status: 500 }],
])('compensation keeps the unchanged last error and {} details for %s', async (_label, logs) => {
  const { row, audits } = await compensatedWithLogs(logs);

  expect(row).toEqual({ status: 'error', last_error: COMPENSATED });
  expect(audits).toEqual([{ details: '{}' }]);
});
