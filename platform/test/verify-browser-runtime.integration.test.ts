import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { awaitFile } from './browser-runtime-fixture.ts';
import { vitestSpawnInterception, vitestStandIn } from './vitest-stand-in-fixture.ts';

const wrapper = fileURLToPath(new URL('../../scripts/verify-browser-runtime.mjs', import.meta.url));
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

interface WrapperRun {
  readonly root: string;
  readonly pid: number | undefined;
  readonly kill: (signal: NodeJS.Signals) => boolean;
  /** Settles on the wrapper's `exit`; `standInExited` is read synchronously inside that event. */
  readonly exited: Promise<WrapperExit>;
}

interface WrapperExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly standInExited: boolean;
  readonly output: string;
}

async function startWrapper(args: string[], hold: boolean, release?: string): Promise<WrapperRun> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-verify-browser-runtime-'));
  const standIn = join(root, 'vitest-stand-in.cjs');
  await writeFile(
    standIn,
    vitestStandIn(root, hold, release === undefined ? undefined : join(root, release)),
    { mode: 0o600 },
  );
  const preload = join(root, 'preload.mjs');
  await writeFile(
    preload,
    `import { syncBuiltinESMExports } from 'node:module';
${vitestSpawnInterception(standIn, join(root, 'spawns.jsonl'))}
syncBuiltinESMExports();
`,
    { mode: 0o600 },
  );
  // `--help`/`-h` skips provisioning: no Docker call, no receipt directory, cleanup returns early.
  const child = spawn(process.execPath, ['--import', preload, wrapper, ...args], {
    cwd: root,
    env: { HOME: root, TMPDIR: root, PATH: '', DMXAPI_KEY: 'fake-dmxapi-key-for-tests' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<WrapperExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({ code, signal, standInExited: existsSync(join(root, 'exit.json')), output });
    });
  });
  return { root, pid: child.pid, kill: (signal) => child.kill(signal), exited };
}

async function spawns(root: string): Promise<unknown[]> {
  const text = await readFile(join(root, 'spawns.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

async function marker(run: WrapperRun, name: string): Promise<Record<string, unknown>> {
  const cancel = new AbortController();
  try {
    await Promise.race([
      awaitFile(
        join(run.root, name),
        AbortSignal.any([cancel.signal, AbortSignal.timeout(10_000)]),
      ),
      run.exited.then(({ code, signal, output }) => {
        if (existsSync(join(run.root, name))) return;
        throw new Error(
          `Wrapper exited before ${name}: code=${String(code)}; signal=${String(signal)}; output=${output}`,
        );
      }),
    ]);
    return JSON.parse(await readFile(join(run.root, name), 'utf8')) as Record<string, unknown>;
  } finally {
    cancel.abort();
  }
}

// A regression must not leave the held stand-in owning this test's pipes.
async function killStandIn(root: string): Promise<void> {
  const started = await readFile(join(root, 'started.json'), 'utf8').catch(() => '{}');
  const { pid } = JSON.parse(started) as { pid?: unknown };
  if (typeof pid !== 'number') return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
  }
}

it.each([
  ['docker', '--help'],
  ['model', '--help'],
  ['docker', '-h'],
])('launches %s %s as vitest directly under this Node', async (lane, flag) => {
  const run = await startWrapper([lane, flag], false);
  try {
    const { code } = await run.exited;
    expect(await spawns(run.root)).toEqual([
      { file: process.execPath, args: [vitest, 'run', '--project', lane, flag] },
    ]);
    expect(code).toBe(0);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

it.each([
  ['SIGTERM', 143],
  ['SIGINT', 130],
] as const)(
  'forwards %s to vitest and settles only after vitest has exited',
  async (signal, expected) => {
    const run = await startWrapper(['docker', '--help'], true);
    try {
      const started = await marker(run, 'started.json');
      expect(started.args).toEqual(['run', '--project', 'docker', '--help']);
      expect(run.kill(signal)).toBe(true);
      const { code, standInExited } = await run.exited;
      expect(JSON.parse(await readFile(join(run.root, 'signal.json'), 'utf8'))).toMatchObject({
        signal,
      });
      expect({ code, standInExited }).toEqual({ code: expected, standInExited: true });
    } finally {
      await killStandIn(run.root);
      await rm(run.root, { recursive: true, force: true });
    }
  },
);

it('keeps one idempotent handler for a second SIGTERM while vitest is still settling', async () => {
  const run = await startWrapper(['docker', '--help'], true, 'release');
  try {
    await marker(run, 'started.json');
    expect(run.kill('SIGTERM')).toBe(true);
    expect(await marker(run, 'signal.json')).toMatchObject({ signal: 'SIGTERM' });
    expect(run.kill('SIGTERM')).toBe(true);
    // Only a live wrapper handler can forward the second signal to the held stand-in.
    const second = await Promise.race([
      run.exited.then(({ code, signal }) => ({ code, signal })),
      marker(run, 'repeat.json').then(() => 'wrapper alive'),
    ]);
    expect(second).toBe('wrapper alive');
    await writeFile(join(run.root, 'release'), '', { mode: 0o600 });
    const { code, signal, standInExited } = await run.exited;
    expect({ code, signal, standInExited }).toEqual({
      code: 143,
      signal: null,
      standInExited: true,
    });
  } finally {
    await killStandIn(run.root);
    await rm(run.root, { recursive: true, force: true });
  }
}, 20_000);
