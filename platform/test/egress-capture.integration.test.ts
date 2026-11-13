import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { DockerCommand } from './docker-command.ts';
import { captureContainer, confirmExited, countEgress, findTcpdump } from './egress-capture.ts';

// Stands in for `timeout`+`tcpdump`: canned `-i any` LINUX_SLL2 lines; on SIGINT tcpdump's interrupt
// newline on stdout, then its stats.
const FAKE_TCPDUMP = `
const mode = process.argv[1];
if (mode === 'refused') { process.stderr.write('sudo: a password is required\\n'); process.exit(1); }
const all = [
  '10:00:00.000001 lo    In  IP 127.0.0.1.41000 > 127.0.0.1.443: Flags [S], seq 1, length 0',
  '10:00:00.000002 eth0  Out IP 198.18.0.18.41001 > 104.16.0.1.443: Flags [S], seq 1, length 0',
  '10:00:00.000003 eth0  Out IP 198.18.0.18.41002 > 198.18.0.17.53: 4660+ A? registry.npmjs.org. (36)',
  '10:00:00.000004 eth0  In  IP 198.18.0.17.53 > 198.18.0.18.41002: 4660 1/0/0 A 104.16.0.1 (52)',
  '10:00:00.000005 eth0  Out IP6 fd00::2.41003 > fd00::1.80: Flags [S], seq 1, length 0',
  '10:00:00.000006 lo    In  IP 127.0.0.1.41005 > 127.0.0.1.80: Flags [P.], length 39: HTTP: GET /payload-must-not-stay HTTP/1.1',
  '10:00:00.000007 eth0  Out IP 198.18.0.18.41004 > 198.18.0.17.9: UDP, length 8',
];
const middle = [...all.slice(0, 3), '', ...all.slice(3)];
const lines = { one: all.slice(-1), garbled: [...all, '10:00:00 garbled'], middle }[mode] ?? all;
const tail = '10:00:00.000008 eth0  Out IP 198.18.0.18.41006 > 104.16.0.1.443: Flags [P.], tail-must-not-stay';
const stat = (n, what) => n + ' packet' + (n === 1 ? '' : 's') + ' ' + what + '\\n';
process.stderr.write('tcpdump: verbose output suppressed, use -v[v]... for full protocol decode\\n');
process.stderr.write('listening on any, link-type ' + (mode === 'sll1' ? 'LINUX_SLL' : 'LINUX_SLL2') + ' (Linux cooked v2), snapshot length 128 bytes\\n');
process.stdout.write(lines.join('\\n') + '\\n');
process.on('SIGINT', () => {
  process.stdout.write('\\n' + ({ blanks: '\\n', after: tail + '\\n', unterminated: tail }[mode] ?? ''));
  const [extra, lost] = [mode === 'extra' ? 1 : 0, mode === 'dropped' ? 1 : 0];
  process.stderr.write('\\n' + stat(lines.length + extra, 'captured') + stat(lines.length + extra, 'received by filter') + stat(lost, 'dropped by kernel'));
  process.exit(0);
});
setTimeout(() => process.exit(3), 20000);
`;
// Stands in for sudo: records its child's pid where the injected /proc reader finds it, relays SIGINT.
const FAKE_SUDO = `
const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(FAKE_TCPDUMP)}, process.argv[1]], { stdio: ['ignore', 'inherit', 'inherit'] });
require('node:fs').writeFileSync(process.argv[2], String(child.pid));
process.on('SIGINT', () => child.kill('SIGINT'));
child.on('exit', (code) => process.exit(code ?? 1));
`;
const ARGV = [
  ...['/usr/bin/sudo', '-n', '/usr/bin/timeout', '-k', '5', '90s', '/usr/bin/nsenter', '-t'],
  ...['4242', '-n', '/usr/bin/tcpdump', '-i', 'any', '-nn', '-l', '-s', '512'],
  'port 53 or port 80 or port 443 or udp port 9',
];
const BEFORE = ['dsh web: http', 'DSH_TEAM_MANAGED_POLICY_OBSERVATION'];

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeCapture(mode: string, logs = 'booting\n', state = '4242 true\n', bound = 90) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-team-egress-'));
  cleanup.push(directory);
  const pidFile = join(directory, 'tcpdump.pid');
  const spawned: (readonly string[])[] = [];
  const docker: string[] = [];
  const command: DockerCommand = (args) => {
    docker.push(args.join(' '));
    const stdout = args[0] === 'inspect' ? state : logs;
    return { status: stdout === 'fail' ? 1 : 0, stdout, stderr: '' };
  };
  let sudo = -1;
  const started = captureContainer(command, 'dsh-team-test-start', bound, BEFORE, {
    spawn: (argv) => {
      spawned.push(argv);
      const child = spawn(process.execPath, ['-e', FAKE_SUDO, mode, pidFile], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      sudo = child.pid ?? -1;
      return child;
    },
    children: (pid) => (pid === sudo ? [Number(readFileSync(pidFile, 'utf8'))] : []),
    comm: (pid) => (pid === sudo ? 'timeout' : 'tcpdump'),
  });
  return { started, spawned, docker, tcpdump: () => Number(readFileSync(pidFile, 'utf8')) };
}

it('counts packets by loopback and filter port, keeps DNS query names only and confirms tcpdump exited', async () => {
  const { started, spawned, docker, tcpdump } = fakeCapture('normal');

  const capture = await started;
  await capture.drain();
  const evidence = await capture.stop();

  expect(spawned).toEqual([ARGV]);
  expect(docker).toEqual([
    'inspect -f {{.State.Pid}} {{.State.Running}} dsh-team-test-start',
    'logs dsh-team-test-start',
  ]);
  expect(evidence).toEqual({
    tcpdumpPid: tcpdump(),
    attachMs: expect.any(Number) as unknown,
    lo: { '53': 0, '80': 1, '443': 1, '9': 0, ptr: 0 },
    other: { '53': 2, '80': 1, '443': 1, '9': 1 },
    dnsQueries: ['registry.npmjs.org.'],
    notable: [
      'eth0 Out 198.18.0.18.41001 > 104.16.0.1.443',
      'eth0 In 198.18.0.17.53 > 198.18.0.18.41002 4660 1/0/0 A 104.16.0.1',
      'eth0 Out fd00::2.41003 > fd00::1.80',
    ],
    notableDropped: 0,
    captured: 7,
    exitCode: 0,
    exited: 'ESRCH',
  });
  expect(JSON.stringify(evidence)).not.toContain('payload-must-not-stay');
  expect(await capture.stop()).toBe(evidence);
});

it.each([
  ['sudo refuses unattended', 'refused', 'booting', /never listened: sudo: .*pid never recorded/],
  ['the link type names no interface', 'sll1', 'booting', 'link type LINUX_SLL names no interface'],
  ['DSH announced first', 'normal', 'dsh web: http://198.18.0.18:3080/', 'listened after the'],
  ['the observer marked', 'normal', 'DSH_TEAM_MANAGED_POLICY_OBSERVATION{}', 'listened after'],
  ['the stop failed too', 'dropped', 'dsh web: http', /listened after the.*; stop: .*incomplete/],
])('refuses a capture when %s and leaves no tcpdump behind', async (_case, mode, logs, message) => {
  const { started, tcpdump } = fakeCapture(mode, logs);

  await expect(started).rejects.toThrow(message);

  expect(() => process.kill(tcpdump(), 0)).toThrow(/ESRCH/);
});

it('accepts the singular `1 packet captured` of a capture holding only the canary', async () => {
  const capture = await fakeCapture('one').started;

  expect(await capture.stop()).toMatchObject({ captured: 1, other: { '9': 1, '443': 0 } });
});

it.each([
  ['dropped', 'incomplete capture'],
  ['extra', 'incomplete capture'],
])('fails the stop when tcpdump reports %s packets', async (mode, message) => {
  const capture = await fakeCapture(mode).started;

  await expect(capture.stop()).rejects.toThrow(message);
});

it.each([
  ['garbled', 'unparseable packet line "10:00:00 garbled"'],
  [
    'unterminated',
    'unterminated packet line "10:00:00.000008 eth0  Out IP 198.18.0.18.41006 > 104.16.0.1.443"',
  ],
  ['blanks', 'line "" after the interrupt newline'],
  [
    'after',
    'line "10:00:00.000008 eth0  Out IP 198.18.0.18.41006 > 104.16.0.1.443" after the interrupt newline',
  ],
  [
    'middle',
    'line "10:00:00.000004 eth0  In  IP 198.18.0.17.53 > 198.18.0.18.41002" after the interrupt newline',
  ],
])('fails the stop on a %s line, naming its header only', async (mode, message) => {
  const capture = await fakeCapture(mode).started;

  const error = await capture.stop().then(
    () => undefined,
    (stopError: unknown) => stopError,
  );

  expect(error).toEqual(new Error(`Invalid egress capture: ${message}`));
  expect(String(error)).not.toContain('must-not-stay');
});

it.each<readonly [string, string, string, number]>([
  ['a stopped container', '0 false\n', 'container not running', 90],
  ['a failed inspect', 'fail', 'docker inspect failed', 90],
  ...[0, NaN, Infinity, -1, 1.5].map((b) => [`${String(b)}s`, '4242 true\n', 'bound', b] as const),
])('starts no capture given %s', async (_case, state, message, bound) => {
  const { started, spawned } = fakeCapture('normal', 'booting', state, bound);

  await expect(started).rejects.toThrow(message);

  expect(spawned).toEqual([]);
});

const ANSWER =
  'lo In IP 127.0.0.11.53 > 127.0.0.1.40000: 4321 2/0/0 CNAME a.example., A 192.0.2.1 (68)';
it('keeps each distinct port-53 non-query with its answer and off-loopback 80/443 header, at most 32', () => {
  const syns = Array.from({ length: 30 }, (_, n) => `9.9.9.9.443 > 1.1.1.1.${String(40000 + n)}`);
  const counts = countEgress(
    [
      ANSWER,
      ANSWER,
      'eth0 In IP 1.1.1.1.4 > 2.2.2.2.53: Flags [S], length 0',
      `eth0 In IP 2.2.2.2.53 > 1.1.1.1.4: 7 1/0/0 TXT ${'t'.repeat(130)} (180)`,
      'eth0 In IP 1.1.1.1.4 > 2.2.2.2.443: Flags [S], seq 1',
      'lo In IP 127.0.0.1.4 > 127.0.0.1.80: GET /x',
      'lo In IP 127.0.0.1.443 > 127.0.0.1.4: Flags [S.]',
      'eth0 In IP 1.1.1.1.4 > 2.2.2.2.53: 1+ A? x.test. (24)',
      'eth0 In IP 1.1.1.1.4 > 2.2.2.2.9: UDP, length 1',
      ...syns.map((route) => `eth0 In IP ${route}: Flags [S]`),
      ANSWER,
    ].map((line) => `10:00:00.000001 ${line}`),
  );

  expect(counts.dnsQueries).toEqual(['x.test.']);
  expect(counts.notable).toEqual([
    'lo In 127.0.0.11.53 > 127.0.0.1.40000 4321 2/0/0 CNAME a.example., A 192.0.2.1',
    'eth0 In 1.1.1.1.4 > 2.2.2.2.53 Flags [S], length 0',
    `eth0 In 2.2.2.2.53 > 1.1.1.1.4 7 1/0/0 TXT ${'t'.repeat(108)}`,
    'eth0 In 1.1.1.1.4 > 2.2.2.2.443',
    ...syns.slice(0, 28).map((route) => `eth0 In ${route}`),
  ]);
  expect(counts.notableDropped).toBe(2);
});

const PTR = '35118*$ 2/0/1 PTR host., PTR host.local.';
const EMBEDDED = '127.0.0.11.53';
it.each([
  ['a PTR-only embedded-DNS reply in lo.ptr', 'lo', EMBEDDED, PTR, [1, 1, 0]],
  ['a PTR reply mixed with A in lo.53', 'lo', EMBEDDED, '7 2/0/0 PTR h., A 192.0.2.1', [0, 2, 0]],
  ['an A-only reply in lo.53', 'lo', EMBEDDED, '36730 1/0/1 A 104.16.9.34', [0, 2, 0]],
  ['fewer PTR records than answers in lo.53', 'lo', EMBEDDED, '7 2/0/0 PTR h.', [0, 2, 0]],
  ['an rcode-flagged PTR reply in lo.53', 'lo', EMBEDDED, '7 NXDomain 1/0/0 PTR h.', [0, 2, 0]],
  ['a PTR reply from another source in lo.53', 'lo', '127.0.0.1.53', PTR, [0, 2, 0]],
  ['a PTR reply off loopback in other.53', 'eth0', EMBEDDED, PTR, [0, 1, 1]],
])('counts %s, apart from the PTR query, and still notes it', (_case, face, from, answer, n) => {
  const counts = countEgress([
    `10:00:00.000001 ${face} In IP ${from} > 127.0.0.1.4: ${answer} (60)`,
    '10:00:00.000002 lo Out IP 127.0.0.1.4 > 127.0.0.11.53: 5+ PTR? 1.0.18.198.in-addr.arpa. (42)',
  ]);

  expect([counts.lo.ptr, counts.lo['53'], counts.other['53']]).toEqual(n);
  expect(counts.dnsQueries).toEqual(['1.0.18.198.in-addr.arpa.']);
  expect(counts.notable).toEqual([`${face} In ${from} > 127.0.0.1.4 ${answer}`]);
});

const LONG = `10:00:00 garbled ${'y'.repeat(100)}`;
const HEAD = '10:00:00.000001 eth0  Out IP 1.2.3.4.5 > 5.6.7.8.443';
it.each([
  [
    'a line on no filter port by its header tokens',
    '10:00:00.000001 eth0  Out IP6 fd00::2.41000 > fd00::1.22: Flags [P.], secret',
    'eth0 Out IP6 fd00::2.41000 > fd00::1.22',
  ],
  [
    'a pre-4.99 line up to the colon after its arrow',
    '10:00:00.000001 IP 1.2.3.4.5 > 5.6.7.8.443: GET /secret: a > b: c',
    '"10:00:00.000001 IP 1.2.3.4.5 > 5.6.7.8.443"',
  ],
  ['a line without an arrow up to its colon', 'tcpdump: secret > x', '"tcpdump"'],
  ['a colon before the arrow at that colon', 'warn: secret > x: y', '"warn"'],
  ['an empty line visibly', '', '""'],
  ['a long line at 80 characters', LONG, JSON.stringify(LONG.slice(0, 80))],
  ['a pty CR by its code point', `${HEAD}: secret\r`, `${JSON.stringify(HEAD)} (control U+000D)`],
  ['a line without control characters with no suffix', 'warn \u00fc > x', '"warn \u00fc > x"'],
])('rejects %s instead of bucketing it', (_case, line, header) => {
  const thrown = (() => {
    try {
      return countEgress([line]);
    } catch (error) {
      return error;
    }
  })();

  expect(thrown).toEqual(new Error(`Invalid egress capture: unparseable packet line ${header}`));
  expect(String(thrown)).not.toContain('secret');
});

function tree(edges: Record<number, number[]>, names: Record<number, string>) {
  return { children: (pid: number) => edges[pid] ?? [], comm: (pid: number) => names[pid] ?? '' };
}

it('finds the one tcpdump below sudo with or without its use_pty monitor', () => {
  const monitor = tree({ 1: [2], 2: [3], 3: [4] }, { 2: 'sudo', 3: 'timeout', 4: 'tcpdump' });
  const direct = tree({ 1: [3], 3: [4] }, { 3: 'timeout', 4: 'tcpdump' });
  const twice = tree({ 1: [3], 3: [4, 5] }, { 3: 'timeout', 4: 'tcpdump', 5: 'tcpdump' });
  const stranger = tree({ 1: [3], 3: [4] }, { 3: 'timeout', 4: 'nsenter' });

  expect([findTcpdump(1, monitor), findTcpdump(1, direct)]).toEqual([4, 4]);
  expect(() => findTcpdump(1, twice)).toThrow('tcpdump not found below sudo');
  expect(() => findTcpdump(1, stranger)).toThrow('unexpected process below sudo');
});

// Each probe answers the next code: 'alive' returns normally, any other throws it.
function signals(codes: string[]) {
  let time = 0;
  const kill = () => {
    const code = codes.shift() ?? 'EPERM';
    if (code !== 'alive') throw Object.assign(new Error(code), { code });
  };
  return { kill, now: () => (time += 500) };
}

it('confirms an exit only on ESRCH: EPERM and a live answer are observed again until the bound', async () => {
  await expect(confirmExited(7, signals(['alive', 'EPERM', 'ESRCH']))).resolves.toBeUndefined();
  await expect(confirmExited(7, signals([]))).rejects.toThrow('tcpdump exit unconfirmed');
  await expect(confirmExited(7, signals(['EINVAL']))).rejects.toThrow('EINVAL');
});
