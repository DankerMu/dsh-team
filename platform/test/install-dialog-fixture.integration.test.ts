import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  initializeVerificationSubmissions,
  SUBMISSION_JOURNAL,
} from '../../scripts/verification-submission-storage.mjs';
import { createDockerCommands } from './docker-command.ts';
import { startStandIn, withEgress } from './install-dialog-fixture.ts';
import { freshSubmissionAssessment } from './trusted-docker-audit-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const cleanup: string[] = [];
afterEach(() => {
  delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('settles every exec submission while the stand-in is still starting', async () => {
  const custody = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-team-call-')));
  cleanup.push(custody);
  initializeVerificationSubmissions(custody);
  process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = join(custody, SUBMISSION_JOURNAL);
  let made = '';
  let polls = 0;
  // `docker exec --user 1001 [-d] <container> cmd...` on the host: the exec answers cmd's status;
  // -d answers 0 at once and the stand-in renames its ready marker in only after the first poll.
  const { commandAsync } = createDockerCommands('unused', 'unused', true, (args) => {
    const command = args.slice(args[3] === '-d' ? 5 : 4);
    if (args[3] === '-d') {
      setTimeout(() => {
        writeFileSync(`${made}/ready`, 'http://127.0.0.1:4873/');
      }, 0);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command.includes(`${made}/ready`)) polls += 1;
    const run = spawnSync(command[0] ?? '', command.slice(1), { encoding: 'utf8' });
    if (command[0] === 'mktemp') cleanup.push((made = run.stdout.trim()));
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  });

  const lifecycle = { commandAsync } as unknown as UserImageLifecycle;
  expect(await startStandIn(lifecycle, 'dsh-team-test-start')).toBe(made);
  expect(polls).toBeGreaterThan(1);
  expect(freshSubmissionAssessment(custody)).toBe('{"state":"confirmed"}\n');
});

// tcpdump >= 4.99 `-i any` lines (LINUX_SLL2) inside the instance netns of 198.18.0.16/28.
const LINE = {
  canary: '10:00:00.000001 eth0  Out IP 198.18.0.18.41000 > 198.18.0.17.9: UDP, length 1',
  loopDns: '10:00:00.000002 lo    In  IP 127.0.0.11.53 > 127.0.0.1.41001: 4660 0/0/0 (36)',
  https: '10:00:00.000003 eth0  Out IP 198.18.0.18.41002 > 104.16.0.1.443: Flags [S], length 0',
  query: '10:00:00.000004 eth0  Out IP 198.18.0.18.41003 > 198.18.0.17.53: 1+ A? x.test. (24)',
  dnsSyn: '10:00:00.000005 eth0  Out IP 198.18.0.18.41004 > 198.18.0.17.53: Flags [S], length 0',
  http: '10:00:00.000006 eth0  Out IP 198.18.0.18.41005 > 104.16.0.1.80: Flags [S], length 0',
};
const INSTANCE = 'dsh-team-test-run1-start';

/** One in-process stand-in for sudo→timeout→tcpdump; the canary exec prints its udp/9 line. */
function fakeEgress(
  extra: readonly string[],
  options: { canary?: boolean; dropped?: number } = {},
) {
  const [stdout, stderr] = [new PassThrough(), new PassThrough()];
  let [lines, interrupted] = [0, false];
  const print = (line: string) => {
    lines += 1;
    stdout.write(`${line}\n`);
  };
  const child = Object.assign(new EventEmitter(), { pid: 700, exitCode: null, signalCode: null });
  const kill = (signal: string) => {
    interrupted = signal === 'SIGINT';
    const stat = (n: number, what: string) => `${String(n)} packets ${what}\n`;
    stderr.write(stat(lines, 'captured') + stat(options.dropped ?? 0, 'dropped by kernel'));
    setTimeout(() => {
      Object.assign(child, { exitCode: 0 });
      child.emit('close', 0);
    }, 20);
    return true;
  };
  const spawned: (readonly string[])[] = [];
  const boundary = {
    spawn: (argv: readonly string[]) => {
      spawned.push(argv);
      setTimeout(() => {
        stderr.write(
          'listening on any, link-type LINUX_SLL2 (Linux cooked v2), snapshot length 128 bytes\n',
        );
        extra.forEach(print);
      }, 0);
      // Only the stdio, pid, kill, exit fields and `close` that the capture reads exist.
      return Object.assign(child, { stdout, stderr, kill }) as unknown as ChildProcess;
    },
    children: (pid: number) => (pid === 700 ? [701] : []),
    comm: () => 'tcpdump',
    kill: () => {
      throw Object.assign(new Error('gone'), { code: interrupted ? 'ESRCH' : 'EPERM' });
    },
  };
  const execs: string[][] = [];
  const lifecycle = {
    command: (args: string[]) => {
      const stdout = args[0] === 'inspect' ? '4242 true\n' : 'booting\n';
      return { status: 0, stdout, stderr: '' };
    },
    commandAsync: (args: string[]) => {
      execs.push(args);
      if (options.canary !== false) print(LINE.canary);
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    },
  } as unknown as UserImageLifecycle;
  const recorded: unknown[] = [];
  const stage = {
    label: 'restart' as const,
    network: { name: 'dsh-team-test-net-run1-restart', subnet: '198.18.0.16/28' },
    remaining: () => 29_500,
    evidence: { record: (fields: unknown) => recorded.push(fields) },
  };
  const run = <T>(work: () => Promise<T>) =>
    withEgress(
      lifecycle,
      stage,
      async (onStarted) => {
        await onStarted(INSTANCE);
        return work();
      },
      boundary,
    );
  return { run, boundary, spawned, execs, recorded, stopped: () => interrupted };
}

it('captures from the started instance, fires the gateway canary and gates the counts', async () => {
  const { run, spawned, execs, recorded } = fakeEgress([]);

  const { result, egress } = await run(() => Promise.resolve('accepted'));

  expect(result).toBe('accepted');
  expect(spawned[0]?.slice(0, 9)).toEqual([
    ...['/usr/bin/sudo', '-n', '/usr/bin/timeout', '-k', '5', '60s', '/usr/bin/nsenter'],
    ...['-t', '4242'],
  ]);
  expect(execs).toEqual([
    ['exec', '--user', '1001', INSTANCE, 'node', '-e', expect.any(String), '198.18.0.17'],
  ]);
  const zero = { '53': 0, '80': 0, '443': 0, '9': 0 };
  expect(egress).toEqual({
    ...{ lo: { ...zero, ptr: 0 }, other: { ...zero, '9': 1 }, dnsQueries: [], captured: 1 },
    ...{ notable: [], notableDropped: 0 },
    ...{ attachMs: expect.any(Number) as unknown, tcpdumpPid: 701, exited: 'ESRCH' },
  });
  expect(recorded).toEqual([{ restartEgress: egress }]);
});

it.each([
  ['a DNS query', [LINE.query], true, 'DNS query x.test.'],
  ['port 53 on loopback', [LINE.loopDns], true, 'port 53'],
  ['port 53 beyond loopback without a query', [LINE.dnsSyn], true, 'port 53'],
  ['80 beyond loopback', [LINE.http], true, 'port 80/443 beyond loopback'],
  ['443 beyond loopback', [LINE.https], true, 'port 80/443 beyond loopback'],
  ['no canary', [], false, 'canary not captured'],
])(
  'fails the stage on %s after recording its counts',
  async (_case, extra, canary, message) => {
    const { run, recorded, stopped } = fakeEgress(extra, { canary });

    await expect(run(() => Promise.resolve('accepted'))).rejects.toThrow(message);

    expect(stopped()).toBe(true);
    expect(recorded).toHaveLength(1);
  },
  10_000,
);

it('records the notable headers before gating them', async () => {
  const { run, recorded } = fakeEgress([LINE.loopDns]);

  await expect(run(() => Promise.resolve('accepted'))).rejects.toThrow('port 53');

  const notable = ['lo In 127.0.0.11.53 > 127.0.0.1.41001 4660 0/0/0'];
  const egress = expect.objectContaining({ notable, notableDropped: 0 }) as unknown;
  expect(recorded).toEqual([{ restartEgress: egress }]);
});

it.each([
  ['the primary error', 0, /^browser failed$/],
  ['both errors when the stop fails too', 1, /browser failed; stop: .*incomplete capture/],
])(
  'stops a running capture when the stage fails and rethrows %s',
  async (_case, dropped, message) => {
    const { run, execs, recorded, stopped } = fakeEgress([], { dropped });

    await expect(run(() => Promise.reject(new Error('browser failed')))).rejects.toThrow(message);

    expect(stopped()).toBe(true);
    expect(execs).toEqual([]);
    expect(recorded).toEqual([]);
  },
);

it('fails a stage whose instance never started a capture', async () => {
  const { boundary, spawned } = fakeEgress([]);
  const lifecycle = {} as UserImageLifecycle;
  const stage = { label: 'start' as const, network: { name: 'n', subnet: '198.18.0.16/28' } };
  const evidence = { record: () => undefined };

  const run = withEgress(
    lifecycle,
    { ...stage, remaining: () => 1, evidence },
    () => Promise.resolve('accepted'),
    boundary,
  );

  await expect(run).rejects.toThrow('egress capture never started');
  expect(spawned).toEqual([]);
});
