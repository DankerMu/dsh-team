import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../..');

// The it.each budget below; every wait in a case derives its deadline from it.
const CASE_MS = 30_000;
// Cleanup reserve kept off every body wait. After SIGTERM, a passed case lets pnpm close and its
// group vanish until KILL_MS + REPORT_MS before the case end, so a slow but clean exit does not
// fail it; a failed case already has its verdict and waits at most STOP_MS, keeping its report
// prompt. SIGKILL then gets KILL_MS for the group to vanish, and REPORT_MS covers removing the
// fixture tree and vitest reporting the failure before its hard timeout would replace it.
const STOP_MS = 4000;
const KILL_MS = 1000;
const REPORT_MS = 1000;
const CLEANUP_MS = STOP_MS + KILL_MS + REPORT_MS;
// Characters kept from each output stream; enough for `node --watch`'s restart lines.
const TAIL_CHARS = 4096;

type Attribute = (phase: string, elapsedMs: number) => Promise<Error>;

interface Watch {
  readonly root: string;
  readonly pid: number;
  readonly exited: () => boolean;
  readonly closed: Promise<number | null>;
  /** Names the phase, its elapsed time, receipt.json, pnpm, its group and the output tails. */
  readonly attribute: Attribute;
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  phase: string,
  deadline: number,
  attribute: Attribute,
): Promise<void> {
  const started = Date.now();
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw await attribute(phase, Date.now() - started);
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

// Darwin answers EPERM, not ESRCH, while every member left in the group has exited unreaped;
// on Linux such a zombie group still answers kill(-pgid, 0), which reads as alive.
function signalGroup(pid: number, signal: NodeJS.Signals | 0): 'alive' | 'exiting' | 'absent' {
  try {
    process.kill(-pid, signal);
    return 'alive';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return 'absent';
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return 'exiting';
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

interface Input {
  readonly present: boolean;
  readonly unreadable: boolean;
  readonly invalid: boolean;
  /** The app ignores SIGTERM, so `node --watch` keeps waiting on it and the group stays alive. */
  readonly ignoreTerm?: boolean;
}

async function startWatch(root: string, input: Input): Promise<Watch> {
  const { present, unreadable, invalid, ignoreTerm = false } = input;
  const manifest = await developmentManifest();
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
${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
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
  const child = spawn('pnpm', ['--silent', 'run', 'dev'], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, WATCH_PRECEDENCE: 'inherited' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tails = { stdout: '', stderr: '' };
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream].on('data', (chunk: Buffer) => {
      tails[stream] = (tails[stream] + chunk.toString()).slice(-TAIL_CHARS);
    });
  }
  let exited = false;
  const closed = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      exited = true;
      resolveExit(code);
    });
  });
  void closed.catch(() => undefined);
  const { pid } = child;
  if (pid === undefined) {
    await closed;
    throw new Error('pnpm started without a process id');
  }
  const attribute: Attribute = async (phase, elapsedMs) => {
    const content = await readFile(join(root, 'receipt.json'), 'utf8').catch((error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? 'absent'
        : `unreadable (${String(error)})`,
    );
    return new Error(
      [
        `Timed out waiting for ${phase} after ${String(elapsedMs)} ms`,
        `receipt ${content}`,
        `pnpm ${exited ? 'closed' : 'not closed'}`,
        `pnpm group ${signalGroup(pid, 0)}`,
        `stdout tail ${JSON.stringify(tails.stdout)}`,
        `stderr tail ${JSON.stringify(tails.stderr)}`,
      ].join('; '),
    );
  };
  return { root, pid, exited: () => exited, closed, attribute };
}

/** Bounded stop of the pnpm group; returns what is left behind instead of throwing. */
async function stop(watch: Watch, caseEnd: number, failed: boolean): Promise<string | undefined> {
  const settle = caseEnd - KILL_MS - REPORT_MS;
  const deadline = failed ? Math.min(Date.now() + STOP_MS, settle) : settle;
  try {
    signalGroup(watch.pid, 'SIGTERM');
    const gone = () => watch.exited() && signalGroup(watch.pid, 0) === 'absent';
    await until(gone, 'owned watcher group exit', deadline, watch.attribute);
    return undefined;
  } catch (error) {
    try {
      signalGroup(watch.pid, 'SIGKILL');
      const absent = () => signalGroup(watch.pid, 0) === 'absent';
      await until(absent, 'group exit after SIGKILL', Date.now() + KILL_MS, watch.attribute);
    } catch (kill) {
      return `${String(error)}; ${String(kill)}`;
    }
    return String(error);
  }
}

/** Runs `body` against a started watcher; cleanup never hangs nor replaces the case's failure. */
async function withWatch(
  input: Input,
  caseEnd: number,
  body: (watch: Watch) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dev-watch-'));
  let watch: Watch | undefined;
  let failure: { error: unknown } | undefined;
  try {
    watch = await startWatch(root, input);
    await body(watch);
  } catch (error) {
    failure = { error };
  }
  const residual = watch && (await stop(watch, caseEnd, failure !== undefined));
  await rm(root, { recursive: true, force: true });
  if (failure === undefined) {
    if (residual !== undefined) throw new Error(residual);
    return;
  }
  if (residual !== undefined && failure.error instanceof Error)
    failure.error.message += `; cleanup: ${residual}`;
  throw failure.error;
}

it.each([
  { name: 'absent', present: false, unreadable: false, invalid: false },
  { name: 'present', present: true, unreadable: false, invalid: false },
  { name: 'unreadable', present: true, unreadable: true, invalid: true },
  { name: 'dangling symlink', present: false, unreadable: false, invalid: true },
])(
  'dev preserves native startup and reload with $name environment input',
  async (input) => {
    const caseEnd = Date.now() + CASE_MS;
    const deadline = caseEnd - CLEANUP_MS;
    const { present, invalid } = input;
    await withWatch(input, caseEnd, async ({ root, exited, closed, attribute }) => {
      if (invalid) {
        await until(exited, 'invalid environment rejection', deadline, attribute);
        expect(await closed).toBeGreaterThan(0);
        expect(await receipt(root)).toBeUndefined();
        return;
      }
      await until(
        async () => {
          if (exited()) throw new Error('Development watcher exited before initial boot');
          return (await receipt(root))?.revision === 1;
        },
        'initial watcher boot',
        deadline,
        attribute,
      );
      const initial = await receipt(root);
      expect(initial).toMatchObject({
        revision: 1,
        configured: present ? 'file value # literal' : 'external',
        precedence: 'inherited',
      });

      await writeFile(join(root, 'platform/src/revision.ts'), 'export const revision = 2;\n');
      await until(
        async () => {
          if (exited()) throw new Error('Development watcher exited before source reload');
          return (await receipt(root))?.revision === 2;
        },
        'source reload',
        deadline,
        attribute,
      );
      const reloaded = await receipt(root);
      expect(reloaded).toMatchObject({
        revision: 2,
        configured: present ? 'file value # literal' : 'external',
        precedence: 'inherited',
      });
      expect(reloaded?.pid).not.toBe(initial?.pid);
      if (!present)
        await expect(readFile(join(root, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  },
  CASE_MS,
);

it(
  'attributes a missed source reload to its phase, receipt, live group and output tails',
  async () => {
    const caseEnd = Date.now() + CASE_MS;
    const deadline = caseEnd - CLEANUP_MS;
    const input = { present: false, unreadable: false, invalid: false };
    await withWatch(input, caseEnd, async ({ root, attribute }) => {
      const revision = async (value: number) => (await receipt(root))?.revision === value;
      await until(() => revision(1), 'initial watcher boot', deadline, attribute);
      // revision.ts is never rewritten, so the reload can only time out at this short deadline.
      const missed: unknown = await until(
        () => revision(2),
        'source reload',
        Date.now() + 500,
        attribute,
      ).catch((error: unknown) => error);
      expect(missed).toBeInstanceOf(Error);
      const { message } = missed as Error;
      expect(message).toMatch(/^Timed out waiting for source reload after \d+ ms; /);
      expect(message).toContain('"revision":1');
      expect(message).toContain('pnpm not closed; pnpm group alive');
      // `build:web` runs `node --version`, so the kept stdout tail names that version.
      expect(message).toMatch(/; stdout tail ".*v\d+\.\d+\.\d+.*"; stderr tail "/);
    });
  },
  CASE_MS,
);

it(
  'keeps the case failure and kills a group that ignores SIGTERM within the case budget',
  async () => {
    const caseEnd = Date.now() + CASE_MS;
    const input = { present: false, unreadable: false, invalid: false, ignoreTerm: true };
    const seen: { watch?: Watch } = {};
    const failure: unknown = await withWatch(input, caseEnd, async (watch) => {
      seen.watch = watch;
      const revision = async (value: number) => (await receipt(watch.root))?.revision === value;
      await until(() => revision(1), 'initial watcher boot', caseEnd - CLEANUP_MS, watch.attribute);
      // revision.ts is never rewritten, so the case body fails here on purpose.
      await until(() => revision(2), 'source reload', Date.now() + 500, watch.attribute);
    }).catch((error: unknown) => error);
    expect(Date.now()).toBeLessThan(caseEnd);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /^Timed out waiting for source reload after \d+ ms; .*; cleanup: Error: Timed out waiting for owned watcher group exit after \d+ ms; .*; pnpm group alive; /,
    );
    if (seen.watch === undefined) throw new Error('watcher never started');
    expect(signalGroup(seen.watch.pid, 0)).toBe('absent');
    await expect(stat(seen.watch.root)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  CASE_MS,
);
