import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../..');

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function receipt(root: string) {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('pid' in value) ||
    typeof value.pid !== 'number' ||
    !('revision' in value) ||
    typeof value.revision !== 'number' ||
    !('configured' in value) ||
    typeof value.configured !== 'string' ||
    !('precedence' in value) ||
    typeof value.precedence !== 'string'
  ) {
    throw new Error('Invalid owned watcher receipt');
  }
  return value;
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function developmentManifest() {
  const manifest: unknown = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('scripts' in manifest) ||
    typeof manifest.scripts !== 'object' ||
    manifest.scripts === null ||
    !('dev' in manifest.scripts) ||
    typeof manifest.scripts.dev !== 'string' ||
    !('packageManager' in manifest) ||
    typeof manifest.packageManager !== 'string'
  ) {
    throw new Error('Missing canonical development command');
  }
  return { dev: manifest.scripts.dev, packageManager: manifest.packageManager };
}

it.each([
  { name: 'absent', present: false, unreadable: false, invalid: false },
  { name: 'present', present: true, unreadable: false, invalid: false },
  { name: 'unreadable', present: true, unreadable: true, invalid: true },
  { name: 'dangling symlink', present: false, unreadable: false, invalid: true },
])(
  'dev preserves native startup and reload with $name environment input',
  async ({ present, unreadable, invalid }) => {
    const manifest = await developmentManifest();
    const root = await mkdtemp(join(tmpdir(), 'dsh-dev-watch-'));
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<number | null> | undefined;
    try {
      // Keep the actual package entry and native watcher. Only unrelated build/app payloads
      // are fixtures; trusted source-main smoke separately proves actual platform health.
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          type: 'module',
          packageManager: manifest.packageManager,
          scripts: { dev: manifest.dev, 'build:web': 'node --version' },
        }),
      );
      await symlink(join(repository, 'scripts'), join(root, 'scripts'), 'dir');
      await mkdir(join(root, 'platform/src'), { recursive: true });
      await writeFile(join(root, 'platform/src/revision.ts'), 'export const revision = 1;\n');
      await writeFile(
        join(root, 'platform/src/main.ts'),
        `import { writeFileSync, renameSync } from 'node:fs';
import { revision } from './revision.ts';
writeFileSync('receipt.pending', JSON.stringify({pid: process.pid, revision,
  configured: process.env.WATCH_CONFIGURED ?? 'external',
  precedence: process.env.WATCH_PRECEDENCE}));
renameSync('receipt.pending', 'receipt.json');
setInterval(() => {}, 1000);
`,
      );
      if (present) {
        await writeFile(
          join(root, '.env'),
          'WATCH_CONFIGURED="file value # literal"\nWATCH_PRECEDENCE=file\n',
        );
        if (unreadable) await chmod(join(root, '.env'), 0);
      } else if (invalid) {
        await symlink(join(root, 'missing-env-target'), join(root, '.env'));
      }
      child = spawn('pnpm', ['--silent', 'run', 'dev'], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, WATCH_PRECEDENCE: 'inherited' },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.resume();
      child.stderr?.resume();
      let exited = false;
      closed = new Promise<number | null>((resolveExit, reject) => {
        child?.once('error', reject);
        child?.once('close', (code) => {
          exited = true;
          resolveExit(code);
        });
      });
      void closed.catch(() => undefined);
      if (invalid) {
        await until(() => exited, 'invalid environment rejection');
        expect(await closed).toBeGreaterThan(0);
        expect(await receipt(root)).toBeUndefined();
        return;
      }
      await until(async () => {
        if (exited) throw new Error('Development watcher exited before initial boot');
        return (await receipt(root))?.revision === 1;
      }, 'initial watcher boot');
      const initial = await receipt(root);
      expect(initial).toMatchObject({
        revision: 1,
        configured: present ? 'file value # literal' : 'external',
        precedence: 'inherited',
      });

      await writeFile(join(root, 'platform/src/revision.ts'), 'export const revision = 2;\n');
      await until(async () => {
        if (exited) throw new Error('Development watcher exited before source reload');
        return (await receipt(root))?.revision === 2;
      }, 'source reload');
      const reloaded = await receipt(root);
      expect(reloaded).toMatchObject({
        revision: 2,
        configured: present ? 'file value # literal' : 'external',
        precedence: 'inherited',
      });
      expect(reloaded?.pid).not.toBe(initial?.pid);
      if (!present)
        await expect(readFile(join(root, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (child?.pid !== undefined) {
        signalGroup(child.pid, 'SIGTERM');
        await closed;
        const pid = child.pid;
        await until(() => !signalGroup(pid, 0), 'owned watcher group exit');
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
