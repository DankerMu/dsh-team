import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { createOrchestrator } from '../src/orchestrator/index.ts';
import {
  inspectAsync,
  normalizeInspectMounts,
  registerStartupUsers,
  runNetworkAcceptance,
  startDockerInstance,
  startupClient,
} from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import { profileSeedOracle, profileSeedScript } from './profile-seed-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const SENTINELS = [
  'sessions/retained',
  'storages/retained',
  'attachments/retained',
  '.credentials.yaml',
  'retained',
];
const PRESERVE = `
from pathlib import Path
import json, os, sys
paths = ${JSON.stringify(SENTINELS)}
if sys.argv[1] == 'write':
    for name in paths:
        path = Path('/data/home') / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('retained:' + name)
    Path('/data/work/retained').write_text('work retained')
print(json.dumps({'uid': os.geteuid(), 'home': {name: (Path('/data/home') / name).read_text() for name in paths}, 'work': Path('/data/work/retained').read_text()}))
`;

async function probe(
  lifecycle: UserImageLifecycle,
  userId: string,
  script: string,
  phase: string,
): Promise<string> {
  const name = `dsh-team-test-${lifecycle.runId}-${randomUUID()}`;
  lifecycle.registerContainer(name);
  const result = await lifecycle.commandAsync(
    [
      'run',
      '--rm',
      '--name',
      name,
      '--label',
      `dsh-team.test-run=${lifecycle.runId}`,
      '--network',
      'none',
      '--mount',
      `type=volume,source=dsh-team-home-${userId},target=/data/home`,
      '--mount',
      `type=volume,source=dsh-team-work-${userId},target=/data/work`,
      lifecycle.imageId,
      'python3',
      '-c',
      script,
      phase,
    ],
    30_000,
  );
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Profile restoration probe failed');
  return result.stdout;
}

async function restoreScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const userId = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const siblingId = lifecycle.runId.replaceAll('-', '').slice(-12);
  expect(userId).not.toBe(siblingId);
  const database = openDatabase(join(dirname(lifecycle.overlayDirectory), 'profile-restore.db'));
  const { client, helperIds } = startupClient(lifecycle);
  const owner = createOrchestrator({
    client,
    database,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  try {
    applyMigrations(database);
    registerStartupUsers(lifecycle, database, [userId, siblingId], 'restore.example.test');
    await startDockerInstance(owner, lifecycle, userId, 'restore.example.test');
    const sibling = await startDockerInstance(owner, lifecycle, siblingId, 'restore.example.test');
    const siblingBefore = normalizeInspectMounts(
      await inspectAsync(lifecycle, sibling.containerId),
    );
    await owner.stopUserContainer({ userId, reason: 'admin' });
    const before = JSON.parse(await probe(lifecycle, userId, PRESERVE, 'write')) as unknown;
    expect(before).toEqual({
      uid: 1001,
      home: Object.fromEntries(SENTINELS.map((name) => [name, `retained:${name}`])),
      work: 'work retained',
    });
    const rows = database.prepare('SELECT * FROM instances ORDER BY user_id').all();
    const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
    await probe(
      lifecycle,
      userId,
      `
from pathlib import Path
path = Path('/data/home/profiles/web/cordis.patch.yml')
path.write_text('broken: [')
Path('/data/home/profiles/extra').write_text('remove this entry')
`,
      'damage',
    );

    await owner.restoreUserProfiles({
      userId,
      config: { userImage: lifecycle.imageId, seccompProfilePath: lifecycle.seccomp },
    });
    profileSeedOracle()(await probe(lifecycle, userId, profileSeedScript, 'fresh'));
    for (const mode of ['nested', 'root']) {
      await probe(
        lifecycle,
        userId,
        `
from pathlib import Path
import shutil, sys
profiles = Path('/data/home/profiles')
if sys.argv[1] == 'root':
    shutil.rmtree(profiles)
    profiles.symlink_to('/data/home/sessions', target_is_directory=True)
else:
    (profiles / 'web/escape').symlink_to('/data/home/sessions', target_is_directory=True)
`,
        mode,
      );
      await owner.restoreUserProfiles({
        userId,
        config: { userImage: lifecycle.imageId, seccompProfilePath: lifecycle.seccomp },
      });
      profileSeedOracle()(await probe(lifecycle, userId, profileSeedScript, 'fresh'));
      expect(JSON.parse(await probe(lifecycle, userId, PRESERVE, 'read'))).toEqual(before);
    }

    expect(JSON.parse(await probe(lifecycle, userId, PRESERVE, 'read'))).toEqual(before);
    expect(database.prepare('SELECT * FROM instances ORDER BY user_id').all()).toEqual(rows);
    expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
    expect(normalizeInspectMounts(await inspectAsync(lifecycle, sibling.containerId))).toEqual(
      siblingBefore,
    );
    for (const id of helperIds)
      expect(
        isAbsentResource(
          await lifecycle.commandAsync(['container', 'inspect', id], 15_000),
          'container',
          id,
        ),
      ).toBe(true);
    return JSON.stringify({
      profilesEqual: true,
      writable: true,
      otherDataPreserved: true,
      siblingUnchanged: true,
    });
  } finally {
    await owner.drain();
    database.close();
  }
}

it('restores only stopped-user profiles from the immutable image seed and preserves other data and sibling', async () => {
  await runNetworkAcceptance(restoreScenario, 'profile restoration', (summary) => {
    expect(JSON.parse(summary)).toEqual({
      profilesEqual: true,
      writable: true,
      otherDataPreserved: true,
      siblingUnchanged: true,
    });
  });
});
