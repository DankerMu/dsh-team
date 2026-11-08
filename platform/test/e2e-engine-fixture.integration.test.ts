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

// One owned tree for every capture case: launcher L, its sole dockerd child D, and D's child G.
const L = 41;
const D = 42;
const G = 43;
const uid = 1000;
const repository = '/fixture/repository';
const engine = '/tmp/dsh-team-e2e-engine-x';
const client = '/tmp/dsh-team-e2e-client-y';
const selfNet = 'net:[4026531840]';
const privateNet = 'net:[4026532001]';
const identity = (pid: number) => [String(1000 + pid), 'S'];
const launcherArgs = ['/usr/bin/node', `${repository}/scripts/e2e-engine.mjs`];
const dockerdArgs = [
  '/usr/bin/dockerd',
  '--data-root',
  `${engine}/data`,
  '--host',
  `unix://${client}/docker.sock`,
];
const raise = (type: string) => ({ raise: type });
const times = (count: number, item: unknown) => Array.from({ length: count }, () => item);

interface CaptureReport {
  captured: unknown[];
  launchers: unknown[];
  roots: string[];
  skipped: number[];
  error: { type: string; message: string } | null;
}

type Reads = Record<string, unknown[]>;

function script(dockerd: Reads, more: Record<string, unknown> = {}) {
  const reads: Record<number, Reads> = {
    // L is read at the generation check, the stack pop and the post-read recheck.
    [L]: { birth: times(3, identity(L)), children: [[D]], cmdline: [launcherArgs] },
    [D]: dockerd,
  };
  return {
    child: { pid: L, birth: `linux:${String(L)}:${String(1000 + L)}` },
    uid,
    repository,
    self_net: selfNet,
    reads,
    stats: { [engine]: [{ uid: 0 }], [client]: [{ uid }] },
    ...more,
  };
}

async function capture(input: unknown): Promise<CaptureReport> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-e2e-fixture-capture-'));
  try {
    await mkdir(join(root, 'platform/test'), { recursive: true });
    await mkdir(join(root, 'home'));
    await copyFile(fixture, join(root, 'platform/test/e2e-engine-fixture.py'));

    // The scripted reader never touches the real /proc and creates no process.
    const { stdout } = await run(
      '/usr/bin/python3',
      [join(root, 'platform/test/e2e-engine-fixture.py'), 'capture-script', JSON.stringify(input)],
      {
        env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), PYTHONIOENCODING: 'utf-8' },
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      },
    );
    const lines = stdout.split('\n').filter((line) => line !== '');

    expect(lines).toHaveLength(1);
    // JSON.parse is untyped at this process boundary; each case asserts the fields it relies on.
    const report = JSON.parse(lines[0] ?? '{}') as CaptureReport;
    expect(Object.keys(report).sort()).toEqual([
      'captured',
      'error',
      'launchers',
      'roots',
      'skipped',
    ]);
    return report;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it('skips a private Engine that exited between its argument and namespace reads but still observes its child', async () => {
  const input = script({
    birth: [identity(D), identity(D), null],
    children: [[G]],
    cmdline: [dockerdArgs],
    net_namespace: [raise('FileNotFoundError')],
  });
  input.reads[G] = {
    birth: times(2, identity(G)),
    children: [[]],
    cmdline: [['/usr/bin/sleep', '300']],
  };

  const report = await capture(input);

  expect(report).toEqual({
    captured: [
      [L, String(1000 + L)],
      [D, String(1000 + D)],
      [G, String(1000 + G)],
    ],
    launchers: [[L, String(1000 + L)]],
    roots: [],
    skipped: [D],
    error: null,
  });
});

it('skips a candidate whose command line read reports no such process once it is confirmed absent', async () => {
  const input = script(
    { birth: [identity(D), null], children: [[]], cmdline: [raise('ProcessLookupError')] },
    { stats: {} },
  );

  const report = await capture(input);

  expect(report).toEqual({
    captured: [[L, String(1000 + L)]],
    launchers: [[L, String(1000 + L)]],
    roots: [],
    skipped: [D],
    error: null,
  });
});

it('fails a namespace read that is denied rather than treating it as exit', async () => {
  const input = script({
    birth: times(2, identity(D)),
    children: [[]],
    cmdline: [dockerdArgs],
    net_namespace: [raise('PermissionError')],
  });

  const report = await capture(input);

  expect(report.error?.type).toBe('PermissionError');
  expect(report.skipped).toEqual([]);
});

it('fails a namespace read that is not found while the birth identity is still present', async () => {
  const input = script({
    birth: times(3, identity(D)),
    children: [[]],
    cmdline: [dockerdArgs],
    net_namespace: [raise('FileNotFoundError')],
  });

  const report = await capture(input);

  expect(report.error?.type).toBe('FileNotFoundError');
  expect(report.skipped).toEqual([]);
});

it('fails a present private Engine that shares the caller network namespace and records none of its roots', async () => {
  const input = script({
    birth: times(2, identity(D)),
    children: [[]],
    cmdline: [dockerdArgs],
    net_namespace: [selfNet],
  });

  const report = await capture(input);

  expect(report.error?.message).toBe('Private Engine shares caller network namespace');
  expect(report.roots).toEqual([]);
});

it('fails a present private Engine whose engine root has the wrong authority before any later read', async () => {
  // The client stat and namespace stay unconsumed: the capture error outranks leftover reads.
  const input = script(
    {
      birth: times(2, identity(D)),
      children: [[]],
      cmdline: [dockerdArgs],
      net_namespace: [privateNet],
    },
    { stats: { [engine]: [{ uid }], [client]: [{ uid }] } },
  );

  const report = await capture(input);

  expect(report.error).toEqual({
    type: 'RuntimeError',
    message: 'Private runtime authority mismatch',
  });
});

it('records the launcher and both private roots once across repeated complete observations', async () => {
  const input = script(
    {
      birth: times(4, identity(D)),
      children: [[], []],
      cmdline: times(2, dockerdArgs),
      net_namespace: times(2, privateNet),
    },
    { observations: 2, stats: { [engine]: times(2, { uid: 0 }), [client]: times(2, { uid }) } },
  );
  input.reads[L] = {
    birth: times(6, identity(L)),
    children: [[D], [D]],
    cmdline: times(2, launcherArgs),
  };

  const report = await capture(input);

  expect(report).toEqual({
    captured: [
      [L, String(1000 + L)],
      [D, String(1000 + D)],
    ],
    launchers: [[L, String(1000 + L)]],
    roots: [engine, client],
    skipped: [],
    error: null,
  });
});
