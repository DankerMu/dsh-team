import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { ownerPresent, withTrustedDockerFixture } from './trusted-docker-fixture.ts';
import {
  claimUncaptured,
  classifyOwnerChildren,
  publishedCommand,
} from './trusted-docker-uncaptured-fixture.ts';
import type { ProcessRow } from './trusted-docker-uncaptured-fixture.ts';
import { groupIsAbsent } from '../../scripts/trusted-docker-record.mjs';

// As in the custody deadline case: the wait starts at the 5s fixture deadline and ends near 15s,
// below the 20_000 case bound; fixture.deadline has passed by then.
const COMMAND_LAUNCH_MS = 10_000;

// The owner sleeps 4s before its manifest and its start gets the last 2.5s of the 5s case
// deadline, so cleanup finds it uncaptured, held after spawning its command, before child.json.
// The owner publishes the command pid as soon as its spawn returns, long before the leaf is ready.
it('retires the command group of a start killed before its owner published the command', async () => {
  const pids = { directory: '', owner: 0, command: 0, receipt: '' };
  try {
    const failed = await withTrustedDockerFixture(
      'unpublished-command',
      async (fixture) => {
        pids.directory = fixture.directory;
        await delay(Math.max(0, fixture.deadline - Date.now() - 2500));
        expect(() => fixture.start()).toThrow(/^command start: killed at the case deadline after/);
        const base = join(fixture.home, '.local/share/dsh-team/docker-verification');
        const root = join(base, readdirSync(base)[0] ?? 'missing');
        pids.receipt = join(root, 'child.json');
        pids.owner = Number(
          record(record(JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8'))).owner).pid,
        );
        const request = record(JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')));
        // A held leaf writes nothing more, so its group outlives the owner unless it is retired.
        const leaf = join(String(request.temporary), 'child-ready.json');
        for (const until = Date.now() + COMMAND_LAUNCH_MS; !existsSync(leaf);) {
          if (Date.now() >= until) throw new Error('Held owner launched no ready command');
          await delay(50);
        }
        const command = publishedCommand(fixture.repository);
        if (command === undefined) throw new Error('Held owner published no command');
        pids.command = command;

        expect(existsSync(pids.receipt)).toBe(false);
        expect(groupIsAbsent(pids.command)).toBe(false);
      },
      undefined,
      Date.now() + 5000,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(groupIsAbsent(pids.command)).toBe(true);
    expect(ownerPresent(pids.owner)).toBe(false);
    expect(existsSync(pids.receipt)).toBe(false);
    expect(failed).toBeInstanceOf(AggregateError);
    expect((failed as AggregateError).errors.map(String)).toEqual([
      `Error: Uncaptured custody fixture authority retained: command ${String(pids.command)}`,
    ]);
  } finally {
    for (const pid of [pids.owner, -pids.command].filter(Boolean))
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already settled by the fixture: the green outcome.
      }
    rmSync(pids.directory, { recursive: true, force: true });
  }
}, 20_000);

// Stub pids are never signalled: every seam below is injected.
const OWNER = 900_001;
const owner: ProcessRow = { pid: OWNER, ppid: 1, pgid: OWNER, command: 'node run.mjs own' };
const child = (pid: number, pgid: number, command: string) => ({ pid, ppid: OWNER, pgid, command });
const pnpm = child(7, 7, 'node /opt/homebrew/bin/pnpm test:docker');
const helper = child(5, OWNER, '/usr/bin/python3 -c birth');
const foreign = { pid: 8, ppid: 3, pgid: 8, command: 'pnpm test:docker' };

const forked = child(7, OWNER, owner.command);
const command = { kind: 'command', pid: 7 };
const inFlight = { kind: 'in-flight child', pid: 7 };
const ambiguous = { kind: 'ambiguous child', pid: 7 };

it.each<[string, ProcessRow[], object]>([
  ['a pnpm leader', [owner, pnpm, helper, foreign], command],
  ['a pnpm.cjs leader', [owner, child(7, 7, 'node /a/pnpm.cjs test:docker')], command],
  ['a standalone pnpm', [owner, child(7, 7, 'pnpm test:docker')], command],
  ['only owner-group helpers', [owner, helper, foreign], { kind: 'none' }],
  ['an unforked owner', [owner], { kind: 'none' }],
  ['a fork before setsid', [owner, forked], inFlight],
  [
    'a setsid fork beside a command',
    [owner, child(6, 6, pnpm.command), { ...forked, pgid: 7 }],
    inFlight,
  ],
  ['a foreign detached child', [owner, child(7, 7, 'node other')], ambiguous],
  ['extra command arguments', [owner, child(7, 7, 'pnpm test:docker --x')], ambiguous],
  ['a second command', [owner, child(6, 6, pnpm.command), pnpm], ambiguous],
  ['an unlisted owner', [pnpm], { kind: 'owner unlisted' }],
])('classifies %s among the owner children', (_scene, rows, scan) => {
  const classified = classifyOwnerChildren(rows, OWNER);

  expect(classified).toEqual(scan);
});

interface Stub {
  /** Answers of live() in call order, the last repeating; a string is thrown, as a reused pid. */
  live?: (boolean | string)[];
  stop?: string;
  stat?: string;
  rows?: ProcessRow[];
  /** The rows of every scan after the first. */
  rescan?: ProcessRow[];
  scanStatus?: number;
  birth?: string | null;
  receipt?: boolean;
  launch?: boolean;
  /** The message settle rejects with. */
  settle?: string;
}

async function claim(stub: Stub) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-uncaptured-'));
  try {
    const temporary = join(root, 'temporary');
    mkdirSync(temporary);
    writeFileSync(join(root, 'request.json'), JSON.stringify({ temporary }));
    if (stub.launch !== false)
      writeFileSync(
        join(root, 'launch.json'),
        JSON.stringify({ owner: { pid: OWNER, birth: 'o' } }),
      );
    if (stub.receipt)
      writeFileSync(join(root, 'child.json'), JSON.stringify({ owner: { pid: 7, birth: 'r' } }));
    const events: string[] = [];
    // A bounded wait polls a load-dependent number of times, so repeats collapse to `<event> …`.
    const note = (event: string) => {
      const last = events.at(-1);
      if (last === event || last === `${event} …`) events[events.length - 1] = `${event} …`;
      else events.push(event);
    };
    const listed = (rows: ProcessRow[]) =>
      rows.map(
        (row) => `${String(row.pid)} ${String(row.ppid)} ${String(row.pgid)} ${row.command}`,
      );
    const answers = [...(stub.live ?? [true])];
    let scans = 0;
    const claimed = await claimUncaptured(root, {
      live: () => {
        const answer = (answers.length > 1 ? answers.shift() : answers[0]) ?? true;
        if (typeof answer === 'string') throw new Error(answer);
        return answer;
      },
      observe: () => (stub.birth === undefined ? 'b' : stub.birth),
      run: (_file, args) => {
        if (args.includes('stat=')) {
          note('ps stat');
          return { status: 0, stdout: stub.stat ?? 'T\n' };
        }
        note('ps scan');
        const rows = (scans++ === 0 ? stub.rows : (stub.rescan ?? stub.rows)) ?? [owner];
        return { status: stub.scanStatus ?? 0, stdout: listed(rows).join('\n') };
      },
      signal: (pid, signal) => {
        note(`${signal} ${String(pid)}`);
        if (stub.stop) throw Object.assign(new Error('stop'), { code: stub.stop });
      },
      settle: (identity) => {
        note(`settle ${String(identity.pid)}`);
        return stub.settle === undefined
          ? Promise.resolve()
          : Promise.reject(new Error(stub.settle));
      },
    });
    const failure = claimed.failure instanceof Error ? claimed.failure.message : claimed.failure;
    return {
      report: claimed.report,
      child: claimed.authority?.child,
      retained: !claimed.authority,
      events,
      failure,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const stopped = ['SIGSTOP 900001', 'ps stat'];
// Stop confirmation precedes the first scan; the owner is settled after the last one.
const frozen = [...stopped, 'ps scan', 'settle 900001'];
const polled = [...stopped, 'ps scan …', 'settle 900001'];
const receiptOnly = [...stopped, 'settle 900001'];
const unstopped = ['SIGSTOP 900001', 'settle 900001'];
const gone = ['settle 900001'];
const killed = [...frozen, 'SIGKILL 900001'];
const scanned = { child: { pid: 7, birth: 'b' } };
const receipted = { child: { pid: 7, birth: 'r' } };
const unsettled = { failure: 'owner unsettled' };
const CHANGED = 'Fixture identity changed; retaining authority';
const UNOBSERVED = 'Fixture process observation unavailable';
const unread = { failure: expect.stringMatching(/^ENOENT/) as unknown };
const unbound = (reason: string) => `command unidentified (${reason})`;
// Two rows wait the full 2s identification bound of the fixture; 10s leaves room under load.
const CLAIM_CASE_MS = 10_000;

it.each<[string, Stub, string, boolean, string[], object?]>([
  ['one command', { rows: [owner, pnpm] }, 'command 7', false, frozen, scanned],
  ['zero children', {}, 'no command started', false, frozen],
  ['in flight', { rows: [owner, forked] }, unbound('in-flight child 7'), true, polled],
  [
    'in flight, then a command',
    { rows: [owner, forked], rescan: [owner, pnpm] },
    'command 7',
    false,
    polled,
    scanned,
  ],
  ['ambiguous', { rows: [owner, child(7, 7, 'sh')] }, unbound('ambiguous child 7'), true, frozen],
  ['a failed scan', { scanStatus: 1 }, unbound('scan failed'), true, frozen],
  ['an unlisted owner', { rows: [pnpm] }, unbound('owner unlisted'), true, frozen],
  [
    'a zombie',
    { rows: [owner, pnpm], birth: null },
    unbound('command 7 unobservable'),
    true,
    frozen,
  ],
  [
    'an unconfirmed stop',
    { stat: 'S\n' },
    unbound('owner stop unconfirmed'),
    true,
    ['SIGSTOP 900001', 'ps stat …', 'settle 900001'],
  ],
  [
    'frozen, receipt',
    { receipt: true, rows: [owner, pnpm] },
    'command 7',
    false,
    receiptOnly,
    receipted,
  ],
  ['gone, receipt', { live: [false], receipt: true }, 'command 7', false, gone, receipted],
  ['gone, no receipt', { live: [false] }, unbound('owner gone without receipt'), true, gone],
  ['gone at its stop', { stop: 'ESRCH' }, unbound('owner gone without receipt'), true, unstopped],
  [
    'a failed stop',
    { stop: 'EPERM' },
    unbound('cleanup failed'),
    true,
    unstopped,
    { failure: 'stop' },
  ],
  [
    'unsettled',
    { rows: [owner, pnpm], settle: 'owner unsettled' },
    'command 7',
    true,
    killed,
    unsettled,
  ],
  // The backstop signals only an owner it still observes under its bound identity.
  [
    'unsettled, then gone',
    { rows: [owner, pnpm], live: [true, false], settle: 'owner unsettled' },
    'command 7',
    true,
    frozen,
    unsettled,
  ],
  [
    'unsettled, its pid reused',
    { rows: [owner, pnpm], live: [true, CHANGED], settle: CHANGED },
    'command 7',
    true,
    frozen,
    { failure: CHANGED },
  ],
  [
    'unsettled, unobservable',
    { rows: [owner, pnpm], live: [true, UNOBSERVED], settle: UNOBSERVED },
    'command 7',
    true,
    frozen,
    { failure: UNOBSERVED },
  ],
  [
    'gone, unsettled',
    { live: [false], settle: 'owner unsettled' },
    unbound('owner gone without receipt'),
    true,
    gone,
    unsettled,
  ],
  ['an unread launch', { launch: false }, unbound('cleanup failed'), true, [], unread],
])(
  'claims an uncaptured owner (%s) with one report',
  async (_scene, stub, report, retained, events, extra) => {
    const claimed = await claim(stub);

    expect(claimed).toEqual({
      child: undefined,
      failure: undefined,
      report,
      retained,
      events,
      ...extra,
    });
  },
  CLAIM_CASE_MS,
);
