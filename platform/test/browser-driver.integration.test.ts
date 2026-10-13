import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import type * as ChildProcess from 'node:child_process';
import type * as Os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  readReceipt,
  registerChrome,
  rescueChrome,
  writeReceipt,
} from '../../scripts/probe-browser-runtime.mjs';

const kernel = vi.hoisted(() => ({ pid: 0, observation: 'live' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  platform: () => 'linux',
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      const selected = args[0] === `/proc/${String(kernel.pid)}/stat`;
      if (selected || args[0] === `/proc/${String(process.pid)}/stat`) {
        if (selected && ['ENOENT', 'ESRCH', 'EACCES'].includes(kernel.observation))
          throw Object.assign(new Error('Controlled kernel observation'), {
            code: kernel.observation,
          });
        if (selected && kernel.observation === 'malformed') return 'invalid process stat';
        const state = selected
          ? ({ zombie: 'Z', dead: 'X', unknown: '?' }[kernel.observation] ?? 'S')
          : 'S';
        const ticks = selected && kernel.observation === 'reused' ? '456' : '123';
        return `${String(selected ? kernel.pid : process.pid)} (owned driver) ${state} ${Array<string>(18).fill('0').join(' ')} ${ticks}`;
      }
      return actual.readFile(...args);
    },
  };
});
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawnSync(binary: string, args: readonly string[]) {
    const [kind, operation, target] = args;
    if (
      binary !== 'docker' ||
      operation !== 'inspect' ||
      !target ||
      !['container', 'network'].includes(kind ?? '')
    )
      throw new Error('Unexpected Docker mutation in never-started receipt control');
    return { status: 1, stdout: '', stderr: `Error: No such ${String(kind)}: ${target}` };
  },
}));

it.each([
  { observation: 'zombie', retired: true },
  { observation: 'dead', retired: true },
  { observation: 'ENOENT', retired: true },
  { observation: 'ESRCH', retired: true },
  { observation: 'reused', retired: true },
  { observation: 'live', retired: false },
  { observation: 'EACCES', retired: false },
  { observation: 'malformed', retired: false },
  { observation: 'unknown', retired: false },
])(
  'preserves external rescue ownership under a $observation driver observation',
  async ({ observation, retired }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-driver-observation-'));
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
      {
        env: { PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      if (!child.pid) throw new Error('Owned observation process missing');
      kernel.pid = child.pid;
      kernel.observation = observation;
      const profile = join(root, 'profile');
      const receiptFile = join(root, 'receipt.json');
      await mkdir(profile, { mode: 0o700 });
      const receipt = await registerChrome({
        runtime: {
          kind: 'docker-isolated-network',
          imageId: `sha256:${'a'.repeat(64)}`,
          chromeDirectory: root,
          chromeSha256: 'b'.repeat(64),
          runId: 'driver-observation',
        },
        origin: 'http://127.0.0.1:12345',
        profile,
        receiptFile,
      });
      await writeReceipt(receiptFile, {
        ...receipt,
        driver: { pid: child.pid, birth: `linux:${String(child.pid)}:123` },
      });
      const before = await readFile(receiptFile, 'utf8');

      if (retired) {
        await rescueChrome(receiptFile);
        expect((await readReceipt(receiptFile)).state).toBe('stopped');
      } else {
        await expect(rescueChrome(receiptFile)).rejects.toThrow();
        expect(await readFile(receiptFile, 'utf8')).toBe(before);
      }
      expect(process.kill(child.pid, 0)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await exited;
      kernel.pid = 0;
      kernel.observation = 'live';
      await rm(root, { recursive: true, force: true });
    }
  },
);
