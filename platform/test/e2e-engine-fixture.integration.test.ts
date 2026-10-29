import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const fixture = new URL('e2e-engine-fixture.py', import.meta.url);
const supervisor = new URL('../../scripts/e2e-engine-supervisor.py', import.meta.url);

it('loads the supervisor as a module without writing its bytecode cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-e2e-fixture-bytecode-'));
  try {
    await mkdir(join(root, 'platform/test'), { recursive: true });
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'home'));
    await copyFile(fixture, join(root, 'platform/test/e2e-engine-fixture.py'));
    await copyFile(supervisor, join(root, 'scripts/e2e-engine-supervisor.py'));

    // HOME must exist and be writable: without HOME, Apple /usr/bin/python3 3.9 itself reports
    // pycache_prefix=None and dont_write_bytecode=True, and SourceFileLoader.set_data swallows
    // OSError for an unwritable cache location; either would make this regression vacuously green.
    // PYTHONDONTWRITEBYTECODE is deliberately absent: the fixture must disable bytecode itself.
    const { stdout } = await run(
      '/usr/bin/python3',
      [join(root, 'platform/test/e2e-engine-fixture.py'), 'load-supervisor'],
      {
        env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), PYTHONIOENCODING: 'utf-8' },
        encoding: 'utf8',
        // Module load only; no subprocess or Docker work can legitimately take this long.
        timeout: 30_000,
        killSignal: 'SIGKILL',
      },
    );
    const lines = stdout.split('\n').filter((line) => line !== '');

    expect(lines).toHaveLength(1);
    // JSON.parse is untyped at this process boundary; every field is asserted below.
    const report = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual(['bytecodeEnabledAtEntry', 'cache', 'loaded']);
    expect(report.loaded).toBe(true);
    expect(report.bytecodeEnabledAtEntry).toBe(true);
    expect(typeof report.cache).toBe('string');
    const cache = String(report.cache);
    expect(existsSync(cache), cache).toBe(false);
    expect(existsSync(join(root, 'scripts/__pycache__'))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
