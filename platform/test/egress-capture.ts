import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { DockerCommand } from './docker-command.ts';

const INVALID = 'Invalid egress capture';
const PORTS = ['53', '80', '443', '9'] as const;
type PortCounts = Record<(typeof PORTS)[number], number>;
// tcpdump >= 4.99 on `-i any` (LINUX_SLL2): time, interface, direction, then the IP header.
const PACKET = /^\d\d:\d\d:\d\d\.\d{6} (\S+) +(In|Out|B|M|P) +(IP6?) (\S+) > (\S+): (.*)$/;
const LISTENING = /^listening on any, link-type (\S+) /m;
const LISTEN_MS = 15_000;
// The relayed SIGINT arms `timeout -k 5`, so tcpdump is gone within 5s of it.
const CLOSE_MS = 15_000;

export interface EgressCounts {
  /** `ptr`: Docker embedded-DNS replies whose answers are all PTR, counted apart from `53`. */
  lo: PortCounts & { ptr: number };
  other: PortCounts;
  dnsQueries: string[];
  notable: string[];
  notableDropped: number;
}
interface EgressEvidence extends EgressCounts {
  tcpdumpPid: number;
  /** Spawn (right after `docker start` returned and the pid inspect) to tcpdump listening. */
  attachMs: number;
  captured: number;
  exitCode: number;
  exited: 'ESRCH';
}
export interface EgressCapture {
  /** Resolves once the udp/9 canary was printed (or after 5s): every earlier packet was too. */
  drain: () => Promise<unknown>;
  /** Idempotent: SIGINT to sudo, bounded close, then tcpdump's exit confirmed. */
  stop: () => Promise<EgressEvidence>;
}
export interface Boundary {
  spawn: (argv: readonly string[]) => ChildProcess;
  children: (pid: number) => number[];
  comm: (pid: number) => string;
  kill: (pid: number, signal: 0) => void;
  now: () => number;
}

const SPAWN: SpawnOptions = {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: '/usr/bin:/bin' },
};
const read = (pid: number, path: string): string =>
  readFileSync(`/proc/${String(pid)}/${path}`, 'utf8');
const LIVE: Boundary = {
  // Its own process group: sudo relays no signal sent from the group it was started in.
  spawn: ([file = '', ...args]) => spawn(file, args, SPAWN),
  children: (pid) =>
    readdirSync(`/proc/${String(pid)}/task`).flatMap((task) =>
      read(pid, `task/${task}/children`).split(' ').filter(Boolean).map(Number),
    ),
  comm: (pid) => read(pid, 'comm').trim(),
  kill: (pid, signal) => void process.kill(pid, signal),
  now: () => performance.now(),
};

function emptyCounts(): EgressCounts {
  const zero = (): PortCounts => ({ '53': 0, '80': 0, '443': 0, '9': 0 });
  const lo = { ...zero(), ptr: 0 };
  return { lo, other: zero(), dnsQueries: [], notable: [], notableDropped: 0 };
}

const port = (address: string): string => address.slice(address.lastIndexOf('.') + 1);

/** A port-53 non-query or off-loopback 80/443 line's header tokens (+ its decoded DNS text). */
function note(counts: EgressCounts, fields: string[], matched: string, query?: string): void {
  const [face, direction, source, target, rest = ''] = fields;
  const dns = matched === '53';
  if (query !== undefined || (!dns && (face === 'lo' || matched === '9'))) return;
  const answer = dns ? ` ${(rest.split(' (', 1)[0] ?? '').slice(0, 120)}` : '';
  const entry = `${String(face)} ${String(direction)} ${String(source)} > ${String(target)}${answer}`;
  if (counts.notable.includes(entry)) return;
  if (counts.notable.length < 32) counts.notable.push(entry);
  else counts.notableDropped += 1;
}

/** tcpdump's reply summary `<id><flags> <an>/<ns>/<ar> <answers> (<length>)`: every answer PTR. */
function ptrOnly(rest: string): boolean {
  const [, count, answers = ''] = /^\d+\*?-?\|?\$? (\d+)\/\d+\/\d+ (.+) \(\d+\)$/.exec(rest) ?? [];
  const records = answers.split(', ');
  return records.length === Number(count) && records.every((r) => /^PTR [^\s,]+$/.test(r));
}

/** Docker's embedded DNS answering on lo with PTR records only goes to `lo.ptr`, else face × port. */
function tally(counts: EgressCounts, fields: string[], matched: keyof PortCounts, query?: string) {
  const [face, source, rest = ''] = fields;
  const embedded = matched === '53' && face === 'lo' && source === '127.0.0.11.53';
  if (embedded && query === undefined && ptrOnly(rest)) counts.lo.ptr += 1;
  else counts[face === 'lo' ? 'lo' : 'other'][matched] += 1;
}

/** A rejected line's distinct C0 and DEL code points, e.g. ` (control U+000D)` for a pty's CR. */
function controls(line: string): string {
  const found = [...new Set(line)].filter((c) => c < ' ' || c === '\x7f');
  const points = found.map((c) => `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return points.length > 0 ? ` (control ${points.join(' ').toUpperCase()})` : '';
}

/**
 * A rejected line's header, quoted, never its payload: up to the first ': ' after its first ' > '
 * (when no ': ' precedes that arrow), else up to its first ': ' or 80 characters.
 */
function header(line: string): string {
  const [arrow, colon] = [line.indexOf(' > '), line.indexOf(': ')];
  const end = colon < 0 ? 80 : arrow >= 0 && arrow < colon ? colon : Math.min(colon, 80);
  return JSON.stringify(line.slice(0, end)) + controls(line);
}

/**
 * Counts packet lines by loopback or not × filter port, keeps DNS query names, `note`s the rest.
 * A line of any other shape fails instead of being bucketed; the counts retain no payload, the
 * failure names only the line's header tokens (or `header` prefix) and `controls`.
 */
export function countEgress(lines: readonly string[], counts = emptyCounts()): EgressCounts {
  for (const line of lines) {
    const [, face, direction, ip, source = '', target = '', rest = ''] = PACKET.exec(line) ?? [];
    const matched = PORTS.find((p) => p === port(target)) ?? PORTS.find((p) => p === port(source));
    if (face === undefined) throw new Error(`${INVALID}: unparseable packet line ${header(line)}`);
    if (matched === undefined) {
      const tokens = `${face} ${String(direction)} ${String(ip)} ${source} > ${target}`;
      throw new Error(`${INVALID}: unparseable packet line ${tokens}${controls(line)}`);
    }
    const query = matched === '53' ? / \S+\? (\S+) /.exec(` ${rest}`)?.[1] : undefined;
    tally(counts, [face, source, rest], matched, query);
    if (query !== undefined && !counts.dnsQueries.includes(query)) counts.dnsQueries.push(query);
    note(counts, [face, String(direction), source, target, rest], matched, query);
  }
  return counts;
}

/** The one tcpdump below sudo, its use_pty monitor (when there is one) and timeout. */
export function findTcpdump(root: number, tree: Pick<Boundary, 'children' | 'comm'>): number {
  const found: number[] = [];
  const walk = (pid: number, depth: number): void => {
    for (const child of tree.children(pid)) {
      const name = tree.comm(child);
      if (name === 'tcpdump') found.push(child);
      else if ((name === 'sudo' || name === 'timeout') && depth < 2) walk(child, depth + 1);
      else throw new Error(`${INVALID}: unexpected process below sudo`);
    }
  };
  walk(root, 0);
  const [pid] = found;
  if (found.length !== 1 || pid === undefined)
    throw new Error(`${INVALID}: tcpdump not found below sudo`);
  return pid;
}

/** Only ESRCH is absence; EPERM is a live root process, observed again within 2000ms at 20ms. */
export async function confirmExited(pid: number, os: Pick<Boundary, 'kill' | 'now'>) {
  const endsAt = os.now() + 2_000;
  for (;;) {
    try {
      os.kill(pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      if (code !== 'EPERM') throw error;
    }
    if (os.now() >= endsAt) throw new Error(`${INVALID}: tcpdump exit unconfirmed`);
    await delay(20);
  }
}

// An unreferenced timer: a settled race leaves nothing holding the process.
const within = <T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> =>
  Promise.race([promise, delay(milliseconds, undefined, { ref: false })]);

interface CaptureTarget {
  pid: number;
  boundSeconds: number;
  /** Read once tcpdump listens: none of `before` may have been logged yet. */
  logs: () => string;
  before: readonly string[];
}

/** Read-only capture in the target's netns: counted in memory, never written, no payload kept. */
async function startCapture(target: CaptureTarget, boundary: Boundary): Promise<EgressCapture> {
  const startedAt = boundary.now();
  const child = boundary.spawn([
    ...['/usr/bin/sudo', '-n', '/usr/bin/timeout', '-k', '5', `${String(target.boundSeconds)}s`],
    ...['/usr/bin/nsenter', '-t', String(target.pid), '-n', '/usr/bin/tcpdump', '-i', 'any'],
    ...['-nn', '-l', '-s', '512', 'port 53 or port 80 or port 443 or udp port 9'],
  ]);
  const counts = emptyCounts();
  const listening = Promise.withResolvers<string>();
  const canary = Promise.withResolvers<undefined>();
  let [stderr, partial, lines, blank] = ['', '', 0, false];
  let rejection: Error | undefined;
  // tcpdump's SIGINT cleanup ends stdout with one bare newline: accepted only as the last line.
  const take = (line: string): void => {
    if (blank) throw new Error(`${INVALID}: line ${header(line)} after the interrupt newline`);
    blank = line === '';
    if (blank) return;
    countEgress([line], counts);
    lines += 1;
  };
  const exited = (): null => null;
  const closed = once(child, 'close').then(([code]) => code as number | null, exited);
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
    const linkType = LISTENING.exec(stderr)?.[1];
    if (linkType !== undefined) listening.resolve(linkType);
  });
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    const complete = (partial + chunk).split('\n');
    partial = complete.pop() ?? '';
    for (const line of complete) {
      try {
        take(line);
      } catch (error) {
        rejection ??= error as Error; // take throws Error only
      }
    }
    if (counts.other['9'] > 0) canary.resolve(undefined);
  });
  let tcpdumpPid: number | undefined;
  let attachMs = 0;
  async function finish(): Promise<EgressEvidence> {
    const early = child.exitCode !== null || child.signalCode !== null;
    if (!early) child.kill('SIGINT');
    const exitCode = await within(closed, CLOSE_MS);
    if (exitCode === undefined) throw new Error(`${INVALID}: capture did not close`);
    if (tcpdumpPid === undefined) throw new Error(`${INVALID}: tcpdump pid never recorded`);
    await confirmExited(tcpdumpPid, boundary);
    if (early) throw new Error(`${INVALID}: capture ended before its stop`);
    if (rejection !== undefined) throw rejection;
    if (partial !== '') throw new Error(`${INVALID}: unterminated packet line ${header(partial)}`);
    if (exitCode !== 0) throw new Error(`${INVALID}: capture exited ${String(exitCode)}`);
    const captured = Number(/^(\d+) packets? captured$/m.exec(stderr)?.[1]);
    if (captured !== lines || !/^0 packets? dropped by kernel$/m.test(stderr)) {
      throw new Error(`${INVALID}: incomplete capture`);
    }
    return { tcpdumpPid, attachMs, ...counts, captured, exitCode, exited: 'ESRCH' };
  }
  let stopped: Promise<EgressEvidence> | undefined;
  const capture: EgressCapture = {
    drain: () => within(canary.promise, 5_000),
    stop: () => (stopped ??= finish()),
  };
  try {
    const linkType = await within(
      Promise.race([listening.promise, closed.then(exited)]),
      LISTEN_MS,
    );
    const first = stderr.split('\n', 1)[0]?.slice(0, 120) ?? '';
    if (typeof linkType !== 'string')
      throw new Error(`${INVALID}: tcpdump never listened: ${first}`);
    attachMs = Math.round(boundary.now() - startedAt);
    tcpdumpPid = findTcpdump(child.pid ?? 0, boundary);
    if (linkType !== 'LINUX_SLL2')
      throw new Error(`${INVALID}: link type ${linkType} names no interface`);
    const logs = target.logs();
    if (target.before.some((text) => logs.includes(text))) {
      throw new Error(`${INVALID}: tcpdump listened after the instance announced`);
    }
  } catch (error) {
    await capture.stop().catch((stopError: unknown) => {
      throw new AggregateError([error, stopError], `${String(error)}; stop: ${String(stopError)}`);
    });
    throw error;
  }
  return capture;
}

/**
 * #409 39.C2: captures a running container's netns from right after its `docker start`. Docker is
 * asked only `inspect` and `logs`, which exit 0 in a passing run; sudo/tcpdump are not Docker
 * resources and go straight to `child_process`. The inner `timeout -k` is their only hard bound.
 */
export async function captureContainer(
  command: DockerCommand,
  container: string,
  boundSeconds: number,
  before: readonly string[],
  boundary: Partial<Boundary> = {},
): Promise<EgressCapture> {
  if (!Number.isSafeInteger(boundSeconds) || boundSeconds < 1)
    throw new Error(`${INVALID}: bound must be a positive integer of seconds`);
  const docker = (args: string[]): string => {
    const result = command(args, 10_000);
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`${INVALID}: docker ${args[0] ?? ''} failed`);
    }
    return result.stdout + result.stderr;
  };
  const state = docker(['inspect', '-f', '{{.State.Pid}} {{.State.Running}}', container]);
  const [pid = '', running] = state.trim().split(' ');
  if (running !== 'true' || !/^[1-9]\d*$/.test(pid)) {
    throw new Error(`${INVALID}: container not running`);
  }
  const logs = (): string => docker(['logs', container]);
  return startCapture({ pid: Number(pid), boundSeconds, logs, before }, { ...LIVE, ...boundary });
}
