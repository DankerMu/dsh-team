import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { awaitFile } from './browser-runtime-fixture.ts';

const PUBLICATIONS = 50;

it('sees a file published at any moment after the wait begins, before or after the watcher is live', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-await-file-'));
  try {
    // Only macOS can turn this red (FSEvents' window before the watcher is live); Linux inotify is live when watch() returns.
    // Each publication lands 0-49 ms in, across the window before a macOS watcher delivers events.
    for (let index = 0; index < PUBLICATIONS; index++) {
      const path = join(root, `marker-${String(index)}.json`);
      const waited = awaitFile(path, AbortSignal.timeout(2000));
      await delay(index);
      await writeFile(`${path}.pending`, '{}', { mode: 0o600 });
      await rename(`${path}.pending`, path);
      await expect(waited, `publication ${String(index)}`).resolves.toBeUndefined();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it('rejects with the completion error when the file never appears', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-await-file-'));
  try {
    await expect(awaitFile(join(root, 'never.json'), AbortSignal.timeout(200))).rejects.toThrow(
      'Owned creation fixture completion missing',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
