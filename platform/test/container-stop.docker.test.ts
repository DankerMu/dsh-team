import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createOrchestrator } from '../src/orchestrator/index.ts';
import type { StartUserContainerInput } from '../src/orchestrator/index.ts';
import { START_MODEL, START_PERMISSION } from './container-start-fixture.ts';
import { inspect, record, startupClient } from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const CONTENTS = {
  effectiveUid: 1001,
  home: 'retirement home 中文\nexact state\n',
  work: 'retirement work 中文\nexact workspace\n',
};
const SIBLING_CONTENTS = {
  effectiveUid: 1001,
  home: 'sibling home remains\n',
  work: 'sibling work remains\n',
};

function sentinelFiles(
  lifecycle: UserImageLifecycle,
  id: string,
  expected: typeof CONTENTS,
  write: boolean,
): void {
  const script = `import json, os
from pathlib import Path
home = Path('/data/home/retirement-sentinel')
work = Path('/data/work/retirement-sentinel')
${
  write
    ? `home.write_text(${JSON.stringify(expected.home)}, encoding='utf-8')
work.write_text(${JSON.stringify(expected.work)}, encoding='utf-8')`
    : ''
}
print(json.dumps({'effectiveUid': os.geteuid(), 'home': home.read_text(encoding='utf-8'), 'work': work.read_text(encoding='utf-8')}, ensure_ascii=False))`;
  // No user override: exec must use the actual startup container's normal uid1001.
  const result = lifecycle.command(['exec', id, 'python3', '-c', script], 15_000);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Sentinel file observation failed');
  expect(JSON.parse(result.stdout)).toEqual(expected);
}

function volumes(lifecycle: UserImageLifecycle, userId: string): unknown {
  const result = lifecycle.command(
    ['volume', 'inspect', `dsh-team-home-${userId}`, `dsh-team-work-${userId}`],
    15_000,
  );
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Independent retained volume inspection failed');
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== 2) throw new Error('Missing retained volumes');
  for (const [index, name] of [`dsh-team-home-${userId}`, `dsh-team-work-${userId}`].entries()) {
    expect(record(rows[index]).Name).toBe(name);
    expect(record(rows[index]).Labels).toMatchObject({ 'dsh-team.user': userId });
  }
  return rows;
}

function startInput(
  lifecycle: UserImageLifecycle,
  database: DatabaseHandle,
  userId: string,
): StartUserContainerInput {
  const ownership = { 'dsh-team.user': userId };
  lifecycle.registerResource('volume', `dsh-team-home-${userId}`, ownership);
  lifecycle.registerResource('volume', `dsh-team-work-${userId}`, ownership);
  lifecycle.registerResource('container', `dsh-team-u-${userId}`, ownership);
  database
    .prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, `${userId}@retirement.example.test`, 'unused', 'employee', 'active', 1);
  return {
    userId,
    config: {
      userImage: lifecycle.imageId,
      seccompProfilePath: lifecycle.seccomp,
      managedConfigDir: lifecycle.overlayDirectory,
      authority: 'retirement.example:8443',
    },
    modelSettings: START_MODEL,
    modelKey: 'docker-acceptance-only-not-a-model-credential',
    permission: START_PERMISSION,
  };
}

function assertStarted(
  lifecycle: UserImageLifecycle,
  input: StartUserContainerInput,
  containerId: string,
): void {
  const container = inspect(lifecycle, containerId);
  expect(container.Id).toBe(containerId);
  expect(container.Image).toBe(lifecycle.imageId);
  expect(container.Name).toBe(`/dsh-team-u-${input.userId}`);
  expect(record(container.Config)).toMatchObject({
    User: '1001',
    Hostname: `u-${input.userId}`,
    Labels: { 'dsh-team.user': input.userId },
  });
  expect(record(container.State).Running).toBe(true);
  expect(container.Mounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Type: 'volume',
        Name: `dsh-team-home-${input.userId}`,
        Destination: '/data/home',
        RW: true,
      }),
      expect.objectContaining({
        Type: 'volume',
        Name: `dsh-team-work-${input.userId}`,
        Destination: '/data/work',
        RW: true,
      }),
    ]),
  );
}

async function retirementScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const identity = lifecycle.runId.replaceAll('-', '');
  const userId = identity.slice(0, 12);
  const siblingId = identity.slice(-12);
  if (userId === siblingId) throw new Error('Distinct retirement fixture identities required');
  const database = openDatabase(
    join(dirname(lifecycle.overlayDirectory), 'retirement-platform.db'),
  );
  const { client } = startupClient(lifecycle);
  const { startUserContainer, stopUserContainer } = createOrchestrator({ client, database });
  try {
    applyMigrations(database);
    const input = startInput(lifecycle, database, userId);
    const siblingInput = startInput(lifecycle, database, siblingId);
    const started = await startUserContainer(input);
    const siblingStarted = await startUserContainer(siblingInput);
    if (started.outcome !== 'starting' || siblingStarted.outcome !== 'starting')
      throw new Error('Expected configured retirement startup');
    const oldId = started.containerId;
    const siblingContainerId = siblingStarted.containerId;
    assertStarted(lifecycle, input, oldId);
    assertStarted(lifecycle, siblingInput, siblingContainerId);
    sentinelFiles(lifecycle, oldId, CONTENTS, true);
    sentinelFiles(lifecycle, siblingContainerId, SIBLING_CONTENTS, true);
    const originalVolumes = volumes(lifecycle, userId);
    const siblingVolumes = volumes(lifecycle, siblingId);
    const siblingRow = database.prepare('SELECT * FROM instances WHERE user_id = ?').get(siblingId);
    const siblingEvents = database
      .prepare('SELECT * FROM audit_events WHERE target = ? ORDER BY id')
      .all(siblingId);
    const siblingStartedAt = record(inspect(lifecycle, siblingContainerId).State).StartedAt;

    await stopUserContainer({ userId, reason: 'idle' });

    expect(
      isAbsentResource(
        lifecycle.command(['container', 'inspect', oldId], 15_000),
        'container',
        oldId,
      ),
    ).toBe(true);
    expect(volumes(lifecycle, userId)).toEqual(originalVolumes);
    expect(
      database
        .prepare(
          'SELECT status, container_id, image_id, image_tag, upstream_host, upstream_port, dsh_cookie FROM instances WHERE user_id = ?',
        )
        .get(userId),
    ).toEqual({
      status: 'stopped',
      container_id: null,
      image_id: null,
      image_tag: null,
      upstream_host: null,
      upstream_port: null,
      dsh_cookie: null,
    });
    expect(
      database
        .prepare(
          "SELECT event_type, target, target_email, details FROM audit_events WHERE event_type = 'instance.stopped'",
        )
        .all(),
    ).toEqual([
      {
        event_type: 'instance.stopped',
        target: userId,
        target_email: `${userId}@retirement.example.test`,
        details: '{"reason":"idle"}',
      },
    ]);
    const recreated = await startUserContainer(input);
    if (recreated.outcome !== 'starting') throw new Error('Expected configured recreation');
    const newId = recreated.containerId;
    assertStarted(lifecycle, input, newId);
    expect(newId).not.toBe(oldId);
    sentinelFiles(lifecycle, newId, CONTENTS, false);
    expect(volumes(lifecycle, userId)).toEqual(originalVolumes);
    assertStarted(lifecycle, siblingInput, siblingContainerId);
    expect(record(inspect(lifecycle, siblingContainerId).State).StartedAt).toBe(siblingStartedAt);
    sentinelFiles(lifecycle, siblingContainerId, SIBLING_CONTENTS, false);
    expect(volumes(lifecycle, siblingId)).toEqual(siblingVolumes);
    expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(siblingId)).toEqual(
      siblingRow,
    );
    expect(
      database.prepare('SELECT * FROM audit_events WHERE target = ? ORDER BY id').all(siblingId),
    ).toEqual(siblingEvents);
    return JSON.stringify({
      stoppedReason: 'idle',
      oldContainerAbsent: true,
      differentRecreatedId: true,
      sameVolumes: true,
      exactUid1001Contents: true,
      stableHostname: true,
      siblingUnchanged: true,
    });
  } finally {
    database.close();
  }
}

it('preserves exact uid1001 state and workspace files across production stop/delete/recreate while leaving a sibling unchanged', async () => {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires trusted Linux amd64');
  const result = await runUserImage(
    'container-start',
    (summary) => {
      expect(JSON.parse(summary)).toEqual({
        stoppedReason: 'idle',
        oldContainerAbsent: true,
        differentRecreatedId: true,
        sameVolumes: true,
        exactUid1001Contents: true,
        stableHostname: true,
        siblingUnchanged: true,
      });
    },
    undefined,
    retirementScenario,
  );
  process.stdout.write(
    `Docker retirement verified: run=${result.runId} image=${result.image} readback=${result.stdout} cleanup=complete\n`,
  );
});
