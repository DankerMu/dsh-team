import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { ownerPresent } from './case-budget-fixture.ts';
import { START_DELAY_VARIABLE, withTrustedDockerFixture } from './trusted-docker-fixture.ts';
import {
  claimUncaptured,
  classifyOwnerChildren,
  ownerOf,
  publishedCommand,
  UNPUBLISHED_COMMAND_RELEASE,
  waitFor,
} from './trusted-docker-uncaptured-fixture.ts';
import type { ProcessRow } from './trusted-docker-uncaptured-fixture.ts';
import { groupIsAbsent, groupSettlesAfterClose } from '../../scripts/trusted-docker-record.mjs';

// Past the 2.5s start slice below, so a delayed start is killed before it writes launch.json.
const START_DELAY_MS = 3000;
// As in the custody deadline case, one window for the launch and the leaf starts at the 5s fixture
// deadline (fixture.deadline has passed by then); a delayed start adds its delay before both.
const COMMAND_LAUNCH_MS = START_DELAY_MS + 10_000;
// The case: the fixture deadline, the window, and 5s for cleanup and the assertions after it.
const UNCAPTURED_START_CASE_MS = 5000 + COMMAND_LAUNCH_MS + 5000;

// The owner sleeps 4s before its manifest and its start gets the last 2.5s of the 5s case
// deadline, so cleanup finds it uncaptured, held after spawning its command, before child.json.
// The owner publishes the command pid as soon as its spawn returns, long before the leaf is ready.
// The killed start's orphaned CLI writes launch.json only after its owner spawns, so with or
// without a start delay the invocation and launch.json are awaited, never read at once (#718).
it.each([
  ['', 0],
  [' and its launch.json', START_DELAY_MS],
])(
  'retires the command group of a start killed before its owner%s published the command',
  async (_scene, startDelay) => {
    const pids = { directory: '', owner: 0, command: 0, receipt: '' };
    try {
      const failed = await withTrustedDockerFixture(
        'unpublished-command',
        async (fixture) => {
          pids.directory = fixture.directory;
          await delay(Math.max(0, fixture.deadline - Date.now() - 2500));
          expect(() => fixture.start({ [START_DELAY_VARIABLE]: String(startDelay) })).toThrow(
            /^command start: killed at the case deadline after/,
          );
          const base = join(fixture.home, '.local/share/dsh-team/docker-verification');
          const invocation = () =>
            (existsSync(base) ? readdirSync(base)[0] : undefined) ?? 'missing';
          const launch = () => join(base, invocation(), 'launch.json');
          const until = Date.now() + COMMAND_LAUNCH_MS;
          const left = () => until - Date.now();
          await waitFor(() => existsSync(launch()), left(), 'Killed start published no launch');
          const root = join(base, invocation());
          pids.receipt = join(root, 'child.json');
          pids.owner = ownerOf(launch());
          // request.json precedes launch.json, so it is complete once launch.json exists.
          const request = record(JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')));
          // A held leaf writes nothing more, so its group outlives the owner unless it is retired.
          const leaf = join(String(request.temporary), 'child-ready.json');
          await waitFor(() => existsSync(leaf), left(), 'Held owner launched no ready command');
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

      expect(failed).toBeInstanceOf(AggregateError);
      expect((failed as AggregateError).errors.map(String)).toEqual([
        `Error: Uncaptured custody fixture authority retained: command ${String(pids.command)}`,
      ]);
      expect(await groupSettlesAfterClose(pids.command)).toBe(true);
      expect(ownerPresent(pids.owner)).toBe(false);
      expect(existsSync(pids.receipt)).toBe(false);
    } finally {
      for (const pid of [pids.owner, -pids.command].filter(Boolean))
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already settled by the fixture: the green outcome.
        }
      rmSync(pids.directory, { recursive: true, force: true });
    }
  },
  UNCAPTURED_START_CASE_MS,
);

// #692 budgets, shared by (a) and (b); (a) never spends LATE_RECEIPT_MS. The start window is the
// owner's 4s pre-manifest hold, 3s of CLI start margin and at least 2s of identity wait, so the
// captured start returns and its identity wait expires before the deadline cuts either. The
// fixture deadline adds 3s of fixture preparation before the window. Measured locally: the
// preparation took under 0.1s and the start about 4.5s, leaving about 4.5s of identity wait.
const IDENTITY_START_WINDOW_MS = 4000 + 3000 + 2000;
const IDENTITY_FIXTURE_MS = 3000 + IDENTITY_START_WINDOW_MS;
// After the expiry: the held leaf's readiness and (b)'s late child.json, each bounded.
const HELD_LEAF_MS = 5000;
const LATE_RECEIPT_MS = 5000;
// The case: the fixture deadline, both waits above, the claim's 2s stop confirmation and 2s scan,
// the owner's and the command group's 5s settles, the 2s group check below, and 4s of margin.
const IDENTITY_CASE_MS =
  IDENTITY_FIXTURE_MS + HELD_LEAF_MS + LATE_RECEIPT_MS + 2000 + 2000 + 5000 + 5000 + 2000 + 4000;

const errorTree = (error: unknown): unknown =>
  error instanceof AggregateError
    ? { message: error.message, errors: error.errors.map(errorTree) }
    : String(error);

/**
 * A captured start whose owner spawned its command but published no child.json within the
 * identity wait. With `release`, the owner is released after the expiry and writes child.json
 * before cleanup. Pids are read inside the callback, so a failed case still kills them.
 */
async function unpublishedIdentity(release: boolean) {
  const pids = { directory: '', owner: 0, command: 0, receipt: '' };
  try {
    const failed = await withTrustedDockerFixture(
      'unpublished-command',
      async (fixture) => {
        pids.directory = fixture.directory;
        await delay(Math.max(0, fixture.deadline - Date.now() - IDENTITY_START_WINDOW_MS));
        let expired: Error | undefined;
        try {
          await fixture.start();
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          expired = error;
        }
        if (expired === undefined) throw new Error('Held owner published its command identity');
        const base = join(fixture.home, '.local/share/dsh-team/docker-verification');
        const root = join(base, readdirSync(base)[0] ?? 'missing');
        pids.receipt = join(root, 'child.json');
        pids.owner = Number(
          record(record(JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8'))).owner).pid,
        );
        const request = record(JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')));
        // A ready leaf has passed its owner checks and holds, so only a retirement ends its group.
        const leaf = join(String(request.temporary), 'child-ready.json');
        await waitFor(() => existsSync(leaf), HELD_LEAF_MS, 'Held owner launched no ready command');
        const command = publishedCommand(fixture.repository);
        if (command === undefined) throw new Error('Held owner published no command');
        pids.command = command;
        expect(groupIsAbsent(pids.command)).toBe(false);
        if (release) {
          writeFileSync(join(fixture.repository, UNPUBLISHED_COMMAND_RELEASE), 'release');
          await waitFor(
            () => existsSync(pids.receipt),
            LATE_RECEIPT_MS,
            'Released owner wrote no child.json',
          );
        }
        expect(existsSync(pids.receipt)).toBe(release);
        throw expired;
      },
      undefined,
      Date.now() + IDENTITY_FIXTURE_MS,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    return {
      failure: errorTree(failed),
      groupSettled: await groupSettlesAfterClose(pids.command),
      ownerPresent: ownerPresent(pids.owner),
      receipt: existsSync(pids.receipt) ? 'kept' : 'absent',
      expected: {
        failure: {
          message: 'Custody scenario and cleanup failed',
          errors: [
            expect.stringMatching(
              new RegExp(
                `^Error: Command identity unpublished after \\d+ms: pid=${String(pids.owner)} present=true$`,
              ),
            ) as unknown,
            {
              message: 'Owned custody fixture cleanup unconfirmed',
              errors: [
                `Error: Uncaptured custody fixture authority retained: command ${String(pids.command)}`,
              ],
            },
          ],
        },
        groupSettled: true,
        ownerPresent: false,
        receipt: release ? 'kept' : 'absent',
      },
    };
  } finally {
    for (const pid of [pids.owner, -pids.command].filter(Boolean))
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already settled by the fixture: the green outcome.
      }
    rmSync(pids.directory, { recursive: true, force: true });
  }
}

it.each([
  ['spawned but never published', false],
  ['published only after the identity wait', true],
])(
  'claims a captured start whose command identity was %s',
  async (_scene, release) => {
    const { expected, ...outcome } = await unpublishedIdentity(release);

    expect(outcome).toEqual(expected);
  },
  IDENTITY_CASE_MS,
);

// After the expiry, one window for the released owner's result.json and its exit.
const LATE_RESULT_MS = 5000;
// The case: the fixture deadline, the window above, the claim's 2s stop confirmation and 2s scan,
// the owner's 5s settle, and 4s of margin.
const LATE_FINISH_CASE_MS = IDENTITY_FIXTURE_MS + LATE_RESULT_MS + 2000 + 2000 + 5000 + 4000;

/**
 * A captured start whose owner holds before its command spawn past the identity wait. With
 * `release`, its launch then fails, so it writes a settled result.json and exits without
 * child.json before cleanup; without, cleanup freezes the held owner and finds no command.
 */
async function lateFinish(release: boolean) {
  const pids = { directory: '', owner: 0, temporary: '' };
  try {
    const failed = await withTrustedDockerFixture(
      'late-finish',
      async (fixture) => {
        pids.directory = fixture.directory;
        await delay(Math.max(0, fixture.deadline - Date.now() - IDENTITY_START_WINDOW_MS));
        let expired: Error | undefined;
        try {
          await fixture.start();
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          expired = error;
        }
        if (expired === undefined) throw new Error('Held owner published its command identity');
        const base = join(fixture.home, '.local/share/dsh-team/docker-verification');
        const root = join(base, readdirSync(base)[0] ?? 'missing');
        pids.owner = ownerOf(join(root, 'launch.json'));
        const request = record(JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')));
        pids.temporary = String(request.temporary);
        const result = join(root, 'result.json');
        if (release) {
          const released = join(fixture.repository, UNPUBLISHED_COMMAND_RELEASE);
          // This owner publishes no command record, so nothing created the release directory.
          mkdirSync(dirname(released), { recursive: true });
          writeFileSync(released, 'release');
          const until = Date.now() + LATE_RESULT_MS;
          const left = () => until - Date.now();
          await waitFor(() => existsSync(result), left(), 'Released owner wrote no result.json');
          // A live owner would be frozen and scanned instead: claimed for the wrong reason.
          await waitFor(() => !ownerPresent(pids.owner), left(), 'Released owner did not exit');
        }
        const terminal = existsSync(result)
          ? record(JSON.parse(readFileSync(result, 'utf8')))
          : undefined;
        expect({
          failure: terminal?.failure,
          command: terminal?.command,
          receipt: existsSync(join(root, 'child.json')),
        }).toEqual({
          failure: release ? 'launch' : undefined,
          command: release ? { exitCode: null, signal: null, settled: true } : undefined,
          receipt: false,
        });
        throw expired;
      },
      undefined,
      Date.now() + IDENTITY_FIXTURE_MS,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    const unpublished = expect.stringMatching(
      new RegExp(
        `^Error: Command identity unpublished after \\d+ms: pid=${String(pids.owner)} present=true$`,
      ),
    ) as unknown;
    return {
      failure: errorTree(failed),
      ownerPresent: ownerPresent(pids.owner),
      temporary: existsSync(pids.temporary) ? 'kept' : 'deleted',
      expected: {
        // Only the case's own failure: a finished command's claim adds none.
        failure: release
          ? unpublished
          : {
              message: 'Custody scenario and cleanup failed',
              errors: [
                unpublished,
                {
                  message: 'Owned custody fixture cleanup unconfirmed',
                  errors: [
                    'Error: Uncaptured custody fixture authority retained: no command started',
                  ],
                },
              ],
            },
        ownerPresent: false,
        temporary: 'deleted',
      },
    };
  } finally {
    if (pids.owner)
      try {
        process.kill(pids.owner, 'SIGKILL');
      } catch {
        // Already settled by the fixture: the green outcome.
      }
    rmSync(pids.directory, { recursive: true, force: true });
  }
}

it.each([
  ['finished after the identity wait', true],
  ['still held before its command', false],
])(
  'claims a captured start whose owner %s',
  async (_scene, release) => {
    const { expected, ...outcome } = await lateFinish(release);

    expect(outcome).toEqual(expected);
  },
  LATE_FINISH_CASE_MS,
);

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
  /** launch.json records no invocation. */
  anonymous?: boolean;
  /** result.json: a complete settled terminal record, these fields replaced. */
  result?: Record<string, unknown>;
  /** result.json's file mode; 0o600 when unset. */
  resultMode?: number;
  /** manifest.json is written unless false. */
  manifest?: boolean;
  /** The message settle rejects with. */
  settle?: string;
}

const INVOCATION = '00000000-0000-4000-8000-000000000001';
const MANIFEST = JSON.stringify({ invocation: INVOCATION });
const EMPTY_LOG = { bytes: 0, sha256: createHash('sha256').update('').digest('hex') };
// What a released late-finish owner records: its spawn failed, so no group was ever left.
const settledResult = {
  version: 1,
  invocation: INVOCATION,
  manifestDigest: createHash('sha256').update(MANIFEST).digest('hex'),
  state: 'failed',
  command: { exitCode: null, signal: null, settled: true },
  interruption: 'none',
  failure: 'launch',
  output: { complete: true, stdout: EMPTY_LOG, stderr: EMPTY_LOG },
  cleanup: { state: 'confirmed', browserExec: null },
};

function writeTerminal(root: string, stub: Stub) {
  if (stub.manifest !== false)
    writeFileSync(join(root, 'manifest.json'), MANIFEST, { mode: 0o600 });
  if (stub.result === undefined) return;
  const path = join(root, 'result.json');
  writeFileSync(path, JSON.stringify({ ...settledResult, ...stub.result }));
  // Set after the write, so the process umask cannot change the mode under test.
  chmodSync(path, stub.resultMode ?? 0o600);
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
        JSON.stringify({
          ...(stub.anonymous ? {} : { invocation: INVOCATION }),
          owner: { pid: OWNER, birth: 'o' },
        }),
      );
    if (stub.receipt)
      writeFileSync(join(root, 'child.json'), JSON.stringify({ owner: { pid: 7, birth: 'r' } }));
    writeTerminal(root, stub);
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
      finished: claimed.finished,
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
const finish = { finished: true };
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
  // A gone owner without child.json is claimed only from its own validated, settled result.json.
  ['gone, settled result', { live: [false], result: {} }, 'command finished', false, gone, finish],
  ...(
    [
      [
        'an unsettled result',
        { result: { command: { ...settledResult.command, settled: false } } },
      ],
      ['a result of another manifest', { result: { manifestDigest: '0'.repeat(64) } }],
      ['a result of another invocation', { result: { invocation: INVOCATION.replace('1', '2') } }],
      ['an unreadable result', { result: {}, resultMode: 0o644 }],
      ['a result without its manifest', { result: {}, manifest: false }],
      ['a launch without its invocation', { result: {}, anonymous: true }],
    ] as const
  ).map(([scene, terminal]): [string, Stub, string, boolean, string[]] => [
    `gone, ${scene}`,
    { live: [false], ...terminal },
    unbound('owner gone without receipt'),
    true,
    gone,
  ]),
  [
    'gone, receipt and result',
    { live: [false], receipt: true, result: {} },
    'command 7',
    false,
    gone,
    receipted,
  ],
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
