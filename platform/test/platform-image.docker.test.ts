import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { cleanupTargets, output, OWNER_LABEL, registerCleanupTarget } from './docker-cleanup.ts';
import type { CleanupTarget } from './docker-cleanup.ts';
import type { DockerCommand } from './docker-command.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifactProbe = `
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from './platform/dist/config.js';
import { openDatabase, applyMigrations, readSettings, writeSettings } from './platform/dist/db/index.js';
import { assertWebBuild } from './platform/dist/web/index.js';
assert.notEqual(process.getuid(), 0);
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
const config = loadConfig({ PLATFORM_PUBLIC_URL: 'http://platform-image.invalid' });
const profile = await readFile(config.seccompProfilePath);
assert.equal(createHash('sha256').update(profile).digest('hex'), process.argv[1]);
await assertWebBuild();
await assert.rejects(access('platform/dist/main.js', constants.W_OK), { code: 'EACCES' });
const path = join(config.dataDir, 'image-proof.db');
let database = openDatabase(path);
try {
  applyMigrations(database);
  writeSettings(database, { maxRunningInstances: 7 });
} finally { database.close(); }
database = openDatabase(path);
try {
  assert.equal(readSettings(database).maxRunningInstances, 7);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name),
    ['audit_events', 'creation_attempts', 'instances', 'platform_sessions', 'schema_migrations', 'settings', 'users']);
} finally { database.close(); }
const require = createRequire('/app/platform/package.json');
const nativeRoot = dirname(require.resolve('better-sqlite3/package.json'));
assert.equal(existsSync(join(nativeRoot, 'prebuilds')), false, 'Runtime must not select a shipped prebuild');
const loaded = Object.keys(require.cache).filter(path => path.endsWith('.node')).map(path => realpathSync(path));
assert.deepEqual(loaded, [realpathSync(join(nativeRoot, 'build/Release/better_sqlite3.node'))]);
process.stdout.write(JSON.stringify({ uid: process.getuid(), architecture: process.arch, databaseReopened: true, webBuild: true, seccomp: true, applicationReadOnly: true }));
`;

it('ships a non-root standalone platform with working native persistence, web assets and default seccomp', () => {
  expect({ platform: platform(), arch: arch() }).toEqual({ platform: 'linux', arch: 'x64' });
  const runId = randomUUID();
  const image = `dsh-team-test-${runId}:platform`;
  const targets: CleanupTarget[] = [];
  const failures: unknown[] = [];
  const command: DockerCommand = (args, timeout) =>
    spawnSync('docker', [...args], {
      cwd: root,
      timeout,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  const execute = (args: string[], timeout = 30_000) => output(command(args, timeout), args);
  const run = (suffix: string, args: string[]) => {
    const name = `dsh-team-test-${runId}-${suffix}`;
    registerCleanupTarget(targets, runId, { kind: 'container', name });
    execute([
      'create',
      '--network',
      'none',
      '--name',
      name,
      '--label',
      `${OWNER_LABEL}=${runId}`,
      imageId,
      ...args,
    ]);
    return execute(['start', '--attach', name]);
  };
  let imageId = '';
  try {
    registerCleanupTarget(targets, runId, { kind: 'image', name: image });
    const buildArgs = [
      'build',
      '--label',
      `${OWNER_LABEL}=${runId}`,
      '--progress=plain',
      '-t',
      image,
      '-f',
      'platform/Dockerfile',
      '.',
    ];
    const built = command(buildArgs, 600_000);
    output(built, buildArgs);
    process.stdout.write(built.stdout + built.stderr);
    imageId = execute(['image', 'inspect', '--format', '{{.Id}}', image]).trim();
    expect(imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(run('help', ['node', 'platform/dist/cli.js', '--help'])).toContain('admin create');
    const profileHash = createHash('sha256')
      .update(readFileSync(new URL('../../images/seccomp/dsh-user.json', import.meta.url)))
      .digest('hex');
    const observed: unknown = JSON.parse(
      run('artifact', ['node', '--input-type=module', '-e', artifactProbe, profileHash]),
    );
    expect(observed).toMatchObject({
      architecture: 'x64',
      databaseReopened: true,
      webBuild: true,
      seccomp: true,
      applicationReadOnly: true,
    });
    process.stdout.write(
      `Platform image verified: image=${imageId} evidence=${JSON.stringify(observed)}\n`,
    );
  } catch (error) {
    failures.push(error);
  } finally {
    cleanupTargets(command, targets, runId, failures);
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Platform image verification failed');
});
