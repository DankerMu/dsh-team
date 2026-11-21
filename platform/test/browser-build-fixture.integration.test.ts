import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { processBirth } from '../../scripts/probe-browser-native.mjs';
import { retireDescendants } from './browser-build-fixture.ts';
import { caseBudget } from './trusted-docker-fixture.ts';

// An owned child exits by itself after this, so a missed kill fails on its close, not the case
// timeout; it outlasts the child's start, its birth and its observer (bound 3s) under load.
const OWNED_EXIT_MS = 10_000;
// Above the owned child's own exit.
const CASE_MS = 15_000;

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// An owned child that exits 0 when its stdin ends: a clean close proves it was never signalled.
async function owned() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setTimeout(()=>process.exit(0),${String(OWNED_EXIT_MS)});`,
    ],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  children.push(child);
  const closed = once(child, 'close');
  await once(child, 'spawn');
  const pid = Number(child.pid);
  return { child, pid, birth: await processBirth(pid), closed };
}

function retire(...records: { pid: number; birth: string | null }[]) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-descendants-'));
  roots.push(root);
  writeFileSync(
    join(root, 'descendants.jsonl'),
    records.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
  );
  return retireDescendants(root, caseBudget());
}

it(
  'kills a recorded stand-in that is still alive with its recorded birth',
  async () => {
    const { pid, birth, closed } = await owned();

    const reported = retire({ pid, birth });

    expect(reported).toBe(`pid=${String(pid)} alive, killed`);
    expect(await closed).toEqual([null, 'SIGKILL']);
  },
  CASE_MS,
);

it(
  'reports a recorded stand-in that has exited as gone',
  async () => {
    const { child, pid, birth, closed } = await owned();
    child.stdin.end();
    await closed;

    const reported = retire({ pid, birth });

    expect(reported).toBe(`pid=${String(pid)} gone`);
  },
  CASE_MS,
);

it(
  'retains a live pid whose birth differs from its record, sending it no signal',
  async () => {
    const { child, pid, birth, closed } = await owned();
    // Another value in the last birth field: a valid identity of a different process.
    const other = birth.replace(/:(\d+)$/, (_, last: string) => (last === '0' ? ':1' : ':0'));

    const reported = retire({ pid, birth: other });
    child.stdin.end();

    expect(reported).toBe(`pid=${String(pid)} reused, retained`);
    expect(await closed).toEqual([0, null]);
  },
  CASE_MS,
);

it(
  'leaves a stand-in that recorded no birth unobservable and still retires its matching sibling',
  async () => {
    const unrecorded = await owned();
    const sibling = await owned();

    const reported = retire(
      { pid: unrecorded.pid, birth: null },
      { pid: sibling.pid, birth: sibling.birth },
    );
    unrecorded.child.stdin.end();

    expect(reported).toBe(
      `pid=${String(unrecorded.pid)} unobservable, pid=${String(sibling.pid)} alive, killed`,
    );
    expect(await unrecorded.closed).toEqual([0, null]);
    expect(await sibling.closed).toEqual([null, 'SIGKILL']);
  },
  CASE_MS,
);

it(
  'leaves a recorded stand-in unobservable and unsignalled when its observation fails',
  async () => {
    const { child, pid, birth, closed } = await owned();
    // The observer inherits this environment; Node refuses an unknown NODE_OPTIONS flag at startup.
    vi.stubEnv('NODE_OPTIONS', '--no-such-descendant-observer-flag');

    const reported = retire({ pid, birth });
    child.stdin.end();

    expect(reported).toBe(`pid=${String(pid)} unobservable`);
    expect(await closed).toEqual([0, null]);
  },
  CASE_MS,
);
