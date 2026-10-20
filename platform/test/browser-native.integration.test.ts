import type * as ChildProcess from 'node:child_process';
import type * as Os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { liveProcessBirth, processBirth } from '../../scripts/probe-browser-native.mjs';

const native = vi.hoisted(
  (): { status: number | null; stdout: string; error?: NodeJS.ErrnoException } => ({
    status: 0,
    stdout: 'ok 2 1700000000 123456\n',
  }),
);
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  platform: () => 'darwin',
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawnSync(binary: string) {
    if (binary !== '/usr/bin/python3') throw new Error('Unexpected native observer process');
    return { ...native, stderr: '' };
  },
}));
afterEach(() => {
  native.status = 0;
  native.stdout = 'ok 2 1700000000 123456\n';
  delete native.error;
});

it('retains generation identity while a live Darwin process becomes a zombie', async () => {
  const before = await processBirth(42);
  expect(await liveProcessBirth(42)).toBe(before);

  native.stdout = 'ok 5 1700000000 123456\n';

  expect(await processBirth(42)).toBe(before);
  expect(await liveProcessBirth(42)).toBeNull();
});

it('recognizes only the native disappearance result as absence', async () => {
  native.stdout = 'gone\n';

  await expect(processBirth(42)).rejects.toMatchObject({ code: 'ESRCH' });
  expect(await liveProcessBirth(42)).toBeNull();
});

it.each(['missing-interpreter', 'denied-native-query', 'unknown-state', 'invalid-microseconds'])(
  'retains unknown authority for %s rather than claiming process absence',
  async (failure) => {
    if (failure === 'missing-interpreter') {
      native.status = null;
      native.error = Object.assign(new Error('Unavailable fixture interpreter'), {
        code: 'ENOENT',
      });
    }
    if (failure === 'denied-native-query') {
      native.status = 1;
      native.stdout = '';
    }
    if (failure === 'unknown-state') native.stdout = 'ok 6 1700000000 123456\n';
    if (failure === 'invalid-microseconds') native.stdout = 'ok 2 1700000000 1000000\n';

    await expect(processBirth(42)).rejects.toThrow();
    await expect(liveProcessBirth(42)).rejects.toThrow();
  },
);
