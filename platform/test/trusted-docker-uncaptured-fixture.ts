import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { record } from './container-start-docker-fixture.ts';

type Identity = Readonly<Record<string, unknown>>;

// Gitignored in the fixture repository, so the reviewed-checkout check never sees them.
const UNPUBLISHED_COMMAND = '.run/unpublished-command.json';
/** A case that writes this file under the fixture repository releases the held owner (#692). */
export const UNPUBLISHED_COMMAND_RELEASE = '.run/unpublished-command-release';

/**
 * The unpublished-command owner's preload fragment (#661). Only the owner (`own`) is held: once
 * its `pnpm test:docker` spawn returns, it publishes the command pid, then blocks until the
 * release file appears or 30s pass, so neither the spawn event nor child.json can follow before.
 * Its event loop is blocked inside spawn, so the release is polled synchronously in 50ms slices.
 */
export const UNPUBLISHED_COMMAND_PRELOAD = `import {existsSync,mkdirSync,renameSync,writeFileSync} from 'node:fs';
if(process.argv.includes('own')){
  const unpublished=childProcess.spawn;
  childProcess.spawn=(command,args,options)=>{
    const child=unpublished(command,args,options);
    if(command==='pnpm'&&args[0]==='test:docker'){
      const path=new URL(${JSON.stringify(UNPUBLISHED_COMMAND)},import.meta.url);
      mkdirSync(new URL('.run/',import.meta.url),{recursive:true});
      writeFileSync(new URL(path.href+'.pending'),JSON.stringify({pid:child.pid}));
      renameSync(new URL(path.href+'.pending'),path);
      const release=new URL(${JSON.stringify(UNPUBLISHED_COMMAND_RELEASE)},import.meta.url);
      for(const until=Date.now()+30000;!existsSync(release)&&Date.now()<until;)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
    }
    return child;
  };
  syncBuiltinESMExports();
}
`;

/** The command pid the held owner published, once its record is complete. */
export function publishedCommand(repository: string) {
  const path = join(repository, UNPUBLISHED_COMMAND);
  return existsSync(path) ? Number(record(JSON.parse(readFileSync(path, 'utf8'))).pid) : undefined;
}

/** The `owner.pid` a custody receipt (launch.json, child.json) records. */
export const ownerOf = (path: string) =>
  Number(record(record(JSON.parse(readFileSync(path, 'utf8')) as unknown).owner).pid);

/** Polls every 50ms until `ready` holds; throws `missing` once `milliseconds` pass without it. */
export async function waitFor(ready: () => boolean, milliseconds: number, missing: string) {
  for (const until = Date.now() + milliseconds; !ready();) {
    if (Date.now() >= until) throw new Error(missing);
    await delay(50);
  }
}

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

type ChildScan =
  | { readonly kind: 'command' | 'in-flight child' | 'ambiguous child'; readonly pid: number }
  | { readonly kind: 'none' | 'owner unlisted' };

// Any `pnpm` executable path or entry script whose arguments end with the verification script.
const VERIFICATION_COMMAND = /(?:^|[\s/])pnpm(?:\.c?js)?\s(?:.*\s)?test:docker$/;

/**
 * The owner's direct children in one process table. A child with the owner's own command line is
 * a fork that has not exec'd yet; a group leader running the verification command is the command;
 * a child in the owner's group is a non-detached helper (birth probe, ps). Anything else, or a
 * second command, is ambiguous.
 */
export function classifyOwnerChildren(rows: readonly ProcessRow[], owner: number): ChildScan {
  const self = rows.find((row) => row.pid === owner);
  if (self === undefined) return { kind: 'owner unlisted' };
  const commands: number[] = [];
  let inFlight: number | undefined;
  for (const row of rows.filter((candidate) => candidate.ppid === owner)) {
    if (row.command === self.command) inFlight ??= row.pid;
    else if (row.pgid === row.pid && VERIFICATION_COMMAND.test(row.command)) commands.push(row.pid);
    else if (row.pgid !== self.pgid) return { kind: 'ambiguous child', pid: row.pid };
  }
  if (inFlight !== undefined) return { kind: 'in-flight child', pid: inFlight };
  const [command, second] = commands;
  if (second !== undefined) return { kind: 'ambiguous child', pid: second };
  return command === undefined ? { kind: 'none' } : { kind: 'command', pid: command };
}

function processRows(stdout: string) {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n').filter((row) => row.trim() !== '')) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s(.*))?$/.exec(line);
    if (fields === null) return undefined;
    const [, pid, ppid, pgid, command = ''] = fields;
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), command });
  }
  return rows;
}

interface UncapturedCustody {
  /** The owner's identity is live; throws when its birth changed. */
  readonly live: (identity: Identity) => boolean;
  readonly observe: (pid: number) => string | null;
  readonly run: (file: string, args: string[]) => { status: number | null; stdout: string };
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  /** SIGKILL and wait for the absence of one identity. */
  readonly settle: (identity: Identity) => Promise<void>;
}

// A stop takes effect and a fork execs within milliseconds; 2s bounds each under heavy load.
const IDENTIFICATION_MS = 2000;

class UnidentifiedCommand extends Error {}

const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ESRCH';

async function frozen(pid: number, custody: UncapturedCustody) {
  try {
    custody.signal(pid, 'SIGSTOP');
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
  const until = Date.now() + IDENTIFICATION_MS;
  for (;;) {
    const state = custody.run('/bin/ps', ['-o', 'stat=', '-p', String(pid)]);
    if (state.status === 0 && state.stdout.trim().startsWith('T')) return true;
    if (Date.now() >= until) throw new UnidentifiedCommand('owner stop unconfirmed');
    await delay(20);
  }
}

async function scannedCommand(pid: number, custody: UncapturedCustody) {
  const until = Date.now() + IDENTIFICATION_MS;
  for (;;) {
    const listed = custody.run('/bin/ps', ['-ww', '-A', '-o', 'pid=,ppid=,pgid=,command=']);
    const rows = listed.status === 0 ? processRows(listed.stdout) : undefined;
    if (rows === undefined) throw new UnidentifiedCommand('scan failed');
    const scan = classifyOwnerChildren(rows, pid);
    if (scan.kind === 'none') return undefined;
    if (scan.kind === 'command') {
      const birth = custody.observe(scan.pid);
      if (birth === null) throw new UnidentifiedCommand(`command ${String(scan.pid)} unobservable`);
      return Object.freeze({ pid: scan.pid, birth });
    }
    if (scan.kind !== 'in-flight child' || Date.now() >= until)
      throw new UnidentifiedCommand('pid' in scan ? `${scan.kind} ${String(scan.pid)}` : scan.kind);
    await delay(20);
  }
}

/** The command an owner started: its receipt, or, while it is stopped, its scanned child. */
async function boundCommand(owner: Identity, receipt: string, custody: UncapturedCustody) {
  const pid = Number(owner.pid);
  const stopped = custody.live(owner) && (await frozen(pid, custody));
  if (existsSync(receipt))
    return Object.freeze({ ...record(record(JSON.parse(readFileSync(receipt, 'utf8'))).owner) });
  if (!stopped) throw new UnidentifiedCommand('owner gone without receipt');
  return scannedCommand(pid, custody);
}

/** The authority of an invocation whose start died before capture, read once its owner is gone. */
function uncapturedAuthority(root: string, owner: Identity, child?: Identity) {
  const request = record(JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')));
  const temporary = realpathSync(String(request.temporary));
  const { dev, ino } = lstatSync(temporary);
  return { owner, temporary, device: dev, inode: ino, ...(child ? { child } : {}) };
}

function observedLive(identity: Identity, custody: UncapturedCustody) {
  try {
    return custody.live(identity);
  } catch {
    return false;
  }
}

/**
 * Freeze an uncaptured invocation's owner, bind its command, then kill and settle the owner on
 * every path. Only a bound command or none started yields an authority, whose group the caller
 * settles after the owner; any other outcome retains it. The report names the outcome.
 */
export async function claimUncaptured(root: string, custody: UncapturedCustody) {
  let report = 'command unidentified (cleanup failed)';
  const stop = { sent: false };
  const freezing = {
    ...custody,
    signal: (pid: number, signal: NodeJS.Signals) => {
      custody.signal(pid, signal);
      stop.sent = true;
    },
  };
  try {
    const launched = record(JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8')));
    const owner = Object.freeze({ ...record(launched.owner) });
    let child: Identity | undefined;
    try {
      child = await boundCommand(owner, join(root, 'child.json'), freezing);
      report = child ? `command ${String(child.pid)}` : 'no command started';
    } catch (error) {
      if (!(error instanceof UnidentifiedCommand)) throw error;
      report = `command unidentified (${error.message})`;
      return { report };
    } finally {
      await custody.settle(owner).catch((error: unknown) => {
        // A failed settle must not leave a stopped owner stopped, yet only a pid still observed
        // under the owner's birth is signalled: a changed or unobservable identity is not killed.
        try {
          if (stop.sent && observedLive(owner, custody))
            custody.signal(Number(owner.pid), 'SIGKILL');
        } catch (killed) {
          if (!absent(killed)) throw killed;
        }
        throw error;
      });
    }
    return { report, authority: uncapturedAuthority(root, owner, child) };
  } catch (failure) {
    return { report, failure };
  }
}
