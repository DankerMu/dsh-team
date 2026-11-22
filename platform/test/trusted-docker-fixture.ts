import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { record } from './container-start-docker-fixture.ts';
import { CLOSE_RECEIPT_PRELOAD } from './trusted-docker-close-fixture.ts';
import { groupIsAbsent } from '../../scripts/trusted-docker-record.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const birthModule = new URL('../../scripts/probe-browser-native.mjs', import.meta.url).href;

export const CUSTODY_PROXY = 'http://fixture%2Dproxy%2Duser:fixture%2Dproxy%2Dpassword@127.0.0.1:9';

export const FILE_SIZE_LIMIT_PROGRAM = `import os,resource,signal,sys
resource.setrlimit(resource.RLIMIT_FSIZE,(4096,4096))
signal.signal(signal.SIGXFSZ,signal.SIG_IGN)
os.execvp(sys.argv[1],sys.argv[1:])`;

type CustodyMode =
  | 'fail'
  | 'hold'
  | 'output-failed'
  | 'group-observation-failed'
  | 'group-observation-transient'
  | 'group-observation-invalid'
  | 'post-close-member'
  | 'past-expiry-member'
  | 'early-exit'
  | 'release-early'
  | 'release-blind'
  | 'slow-owner'
  | 'retire';

/** Retirement variants of the `retire` mode; the owner preload answers from a fake daemon. */
export type RetirementScenario =
  | 'green'
  | 'mismatch'
  | 'process-writer'
  | 'foreign-writer'
  | 'absent-writer'
  | 'member'
  | 'digest'
  | 'unsettled'
  | 'unbound'
  | 'lock-unavailable';

// The leaf of a member mode publishes its pre-started member identity here before readiness.
export const GROUP_MEMBER_RECORD = 'group-member.json';
// The post-close member announces its handlers; on SIGUSR2 it waits until the command pid in
// child.json vanishes, exits a fixed delay later and atomically records both times. The delay is
// re-armed on Date.now(), the clock both recorded times use; a timer alone can end a few ms early.
export const CLOSE_MEMBER_DELAY_MS = 300;
const CLOSE_MEMBER = `const fs=require('node:fs');const [record,exit]=process.argv.slice(1);let closing=false;
process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});
process.on('SIGUSR2',()=>{if(closing)return;closing=true;const pid=JSON.parse(fs.readFileSync(record,'utf8')).owner.pid;
const poll=setInterval(()=>{try{process.kill(pid,0);}catch{clearInterval(poll);const vanished=Date.now();
const until=vanished+${String(CLOSE_MEMBER_DELAY_MS)};const wait=()=>{const now=Date.now();if(now<until)return setTimeout(wait,until-now);
fs.writeFileSync(exit+'.pending',JSON.stringify({vanished,exited:now}));fs.renameSync(exit+'.pending',exit);process.exit(0);};wait();}},10);});
process.stdout.write('ready');setInterval(()=>{},1000);`;
// The retirement setup publishes its detached fixture platform identity here.
const FAKE_PLATFORM_RECORD = 'fake-platform.json';

interface OwnerIdentity {
  readonly pid: number;
  readonly birth: string;
}

export function ownerPresent(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // Only ESRCH is absence; any other observation error leaves the wait running.
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
  }
  return true;
}

/** Wait for the owner's result.json while the owner lives, failing at once if it exits first. */
export async function awaitResult(
  directory: string,
  owner: OwnerIdentity,
  deadline: number,
  observe: (pid: number) => string | null,
  scene: (directory: string, ownerPid: number) => string,
  pollMs: number,
) {
  const since = Date.now();
  const result = join(directory, 'result.json');
  for (;;) {
    if (existsSync(result)) return;
    if (!ownerPresent(owner.pid)) {
      // Absence before the result: an owner that published and then exited is not a failure.
      if (existsSync(result)) return;
      let identity: string;
      try {
        identity = `identity recheck birth=${JSON.stringify(observe(owner.pid))}`;
      } catch {
        identity = 'identity recheck unavailable';
      }
      throw new Error(
        `Trusted Docker owner exited without publishing result.json: pid=${String(owner.pid)}; birth=${owner.birth}; ${identity}${scene(directory, owner.pid)}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error(
        `Trusted Docker owner still running without result.json after ${String(Date.now() - since)}ms: pid=${String(owner.pid)}${scene(directory, owner.pid)}`,
      );
    await delay(Math.min(pollMs, remaining));
  }
}

/** Inner fixture waits end by the case deadline; cleanup and terminal evidence keep full bounds. */
export function caseBudget(deadline?: number) {
  let reserved = false;
  const limit = (phase: string, milliseconds: number) => {
    if (reserved || deadline === undefined) return milliseconds;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${phase}: case deadline passed before it started`);
    return Math.min(milliseconds, remaining);
  };
  // A spawnSync whose own timeout is cut to the case deadline; a cut kill names its phase and wait.
  const run = (
    phase: string,
    file: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding & { timeout: number },
  ) => {
    const timeout = limit(phase, options.timeout);
    const since = Date.now();
    const result = spawnSync(file, args, { ...options, timeout });
    // Only the cut timeout is the deadline's kill; ENOENT, ENOBUFS and the like pass through.
    if (
      timeout < options.timeout &&
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    )
      throw new Error(
        `${phase}: killed at the case deadline after ${String(Date.now() - since)}ms`,
      );
    return result;
  };
  // A group wait also reports its group, which members can keep present after the leader is gone.
  const stalled = (phase: string, since: number, pid: unknown, group = false) =>
    new Error(
      `${phase} after ${String(Date.now() - since)}ms: pid=${String(pid)} present=${String(ownerPresent(Number(pid)))}${group ? ` group present=${String(ownerPresent(-Number(pid)))}` : ''}`,
    );
  // Terminal evidence is synchronous, so its full bounds end with it.
  const unbounded = <T>(operation: () => T) => {
    const outer = reserved;
    reserved = true;
    try {
      return operation();
    } finally {
      reserved = outer;
    }
  };
  // Cleanup awaits, so a restoring flag would lapse at its first await: this one stays set.
  const reserve = () => {
    reserved = true;
  };
  return {
    deadline: deadline ?? Number.POSITIVE_INFINITY,
    limit,
    run,
    stalled,
    unbounded,
    reserve,
  };
}
type CaseBudget = ReturnType<typeof caseBudget>;

/**
 * Synchronous children of a case that started now with `caseMs` (#656). Each is capped at the
 * whole budget, above what remains before `reserveMs`, so the case deadline always cuts it, with
 * an uncatchable kill; a failure keeps the budget's message and adds its site's descendants.
 */
export function caseSpawn(
  caseMs: number,
  reserveMs: number,
  descendants?: (budget: CaseBudget) => string,
) {
  const budget = caseBudget(Date.now() + caseMs - reserveMs);
  const spawn = (
    phase: string,
    file: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => {
    try {
      return budget.run(phase, file, args, { ...options, timeout: caseMs, killSignal: 'SIGKILL' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let observed: string;
      try {
        observed = descendants?.(budget) ?? 'not observed';
      } catch (failure) {
        // A failed observation must not replace the cut; only its kind is named, never its text.
        observed = `unobservable (${failure instanceof Error ? failure.name : typeof failure})`;
      }
      throw new Error(`${message}; descendants: ${observed}`, { cause: error });
    }
  };
  return { budget, spawn };
}
export type CaseSpawn = ReturnType<typeof caseSpawn>['spawn'];

function prepareCustodyRepository(
  repository: string,
  environment: NodeJS.ProcessEnv,
  mode: CustodyMode,
  budget: CaseBudget,
  scenario?: RetirementScenario,
) {
  const files = [
    'scripts/probe-browser-native.mjs',
    'scripts/probe-browser-receipt.mjs',
    'scripts/probe-browser-network.mjs',
    'scripts/probe-browser-runtime.mjs',
    'scripts/probe-browser-exec.mjs',
    'scripts/byte-listener.mjs',
    'scripts/docker-proxy-environment.mjs',
    'scripts/docker-build-diagnostics.mjs',
    'scripts/verification-submissions.mjs',
    'scripts/verification-submission-storage.mjs',
    'scripts/verification-submission-assessment.mjs',
    'scripts/verification-docker-generations.mjs',
    'scripts/docker-command.mjs',
    'scripts/verification-producer.mjs',
    'scripts/verification-producer-exit.py',
    'platform/test/docker-command.ts',
    'platform/test/docker-cleanup.ts',
    ...readdirSync(join(sourceRoot, 'scripts'))
      .filter((name) => name.startsWith('trusted-docker-'))
      .map((name) => `scripts/${name}`),
    ...readdirSync(join(sourceRoot, 'platform/test'))
      .filter(
        (name) =>
          name.startsWith('trusted-docker-') &&
          !name.endsWith('.test.ts') &&
          !name.endsWith('-fixture.ts'),
      )
      .map((name) => `platform/test/${name}`),
  ];
  for (const relative of files) {
    const destination = join(repository, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(sourceRoot, relative), destination);
  }
  const packageValue: unknown = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
  // Count and code of owner kill(-pid, 0) observations failed before deferring to the real call.
  // The slow owner denies none; it sleeps 4s before publishing, holding its start past a deadline.
  // The post-close member denies none; its owner records its close and group observations.
  const deniedGroupObservations = (
    {
      'group-observation-failed': ['Infinity', 'EPERM'],
      'group-observation-transient': ['3', 'EPERM'],
      'group-observation-invalid': ['1', 'EINVAL'],
      'slow-owner': ['0', 'EPERM'],
      'post-close-member': ['0', 'EPERM'],
    } as Partial<Record<CustodyMode, [string, string]>>
  )[mode];
  const verificationScript =
    mode === 'retire'
      ? 'node --import ./platform/test/trusted-docker-fake-preload.mjs scripts/trusted-docker-run.mjs'
      : deniedGroupObservations === undefined
        ? record(record(packageValue).scripts)['verify:docker']
        : 'node --import ./fixture-preload.mjs scripts/trusted-docker-run.mjs';
  if (scenario !== undefined)
    writeFileSync(join(repository, 'fixture-scenario.json'), JSON.stringify({ scenario }));
  if (deniedGroupObservations !== undefined)
    writeFileSync(
      join(repository, 'fixture-preload.mjs'),
      `import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const spawn=childProcess.spawn;
childProcess.spawn=(command,args,options)=>{
  if(command===process.execPath&&args[1]==='own')
    return spawn(command,['--import',import.meta.url,...args],options);
  return spawn(command,args,options);
};
syncBuiltinESMExports();
${mode === 'slow-owner' ? "if(process.argv.includes('own'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,4000);" : ''}
const kill=process.kill.bind(process);
let denied=${deniedGroupObservations[0]};
process.kill=(pid,signal)=>{
  if(pid<0&&signal===0&&denied>0){denied-=1;throw Object.assign(new Error('owned-group-observation-denied'),{code:${JSON.stringify(deniedGroupObservations[1])}});}
  return kill(pid,signal);
};
${mode === 'post-close-member' ? CLOSE_RECEIPT_PRELOAD : ''}`,
    );
  writeFileSync(
    join(repository, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      scripts: { 'test:docker': 'node fixture-child.mjs', 'verify:docker': verificationScript },
    }),
  );
  writeFileSync(join(repository, '.gitignore'), '.run/\n');
  writeFileSync(
    join(repository, 'fixture-child.mjs'),
    `import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,readFileSync,renameSync,writeFileSync,watch,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {processBirth} from './scripts/probe-browser-native.mjs';
const mode=${JSON.stringify(mode)};
const scenario=${JSON.stringify(scenario ?? null)};
// A same-group member ignores stdio (the captured pipes still close) and both termination signals.
const member=milliseconds=>spawn(process.execPath,['-e','process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});setTimeout(()=>{},'+milliseconds+');'],{stdio:'ignore'});
const custody=dirname(process.env.DSH_TEAM_CI_RESOURCE_JOURNAL);
const manifest=JSON.parse(readFileSync(join(custody,'manifest.json'),'utf8'));
assert.equal(manifest.head,process.env.DSH_TEAM_REVIEWED_HEAD);
assert.equal(await processBirth(manifest.owner.pid),manifest.owner.birth);
assert.equal(process.env.GH_TOKEN,undefined);
assert.equal(process.env.DMXAPI_KEY,undefined);
assert.equal(process.env.SSH_AUTH_SOCK,undefined);
assert.equal(process.env.HTTP_PROXY,${mode === 'fail' ? JSON.stringify(CUSTODY_PROXY) : 'undefined'});
const temporary=process.env.TMPDIR;
const release=join(temporary,'release');
// Readers poll these records, so each appears complete or not at all.
const publish=(name,value)=>{const path=join(temporary,name);writeFileSync(path+'.pending',JSON.stringify(value),{mode:0o600});renameSync(path+'.pending',path);};
// One group signal plus pnpm's native forwarding may deliver SIGINT twice.
// The pre-started post-close member outlives this leaf's exit by its own short, recorded delay.
let retained;
process.on('SIGINT',()=>{writeFileSync(join(temporary,'child-interrupted'),'SIGINT');if(mode==='post-close-member')process.kill(retained.pid,'SIGUSR2');process.exitCode=27;process.exit(27);});
let ready;
const released=new Promise(resolve=>{ready=resolve;});
// Watch events may be late, coalesced or missing, so the watch also checks at once and every 50ms.
const watchRelease=(directory=temporary)=>{const check=()=>{if(existsSync(release))ready();};const watcher=watch(directory,check);const recheck=setInterval(check,50);check();return released.then(()=>{watcher.close();clearInterval(recheck);});};
// The release-blind leaf watches an empty directory, so only its 50ms recheck sees the release.
const blind=mode==='release-blind'?mkdirSync(join(temporary,'blind'),{recursive:true}):undefined;
const held=['hold','post-close-member','past-expiry-member','release-blind','retire','slow-owner'].includes(mode)?watchRelease(blind):undefined;
// This leaf releases itself and watches 500ms after its last write: Darwin FSEvents replayed
// writes made just before watch() (8/8 probes) but none made 100ms or more before it (0/8).
if(mode==='release-early')writeFileSync(release,'release');
if(['past-expiry-member','post-close-member'].includes(mode)||scenario==='member'){
  retained=mode==='post-close-member'?spawn(process.execPath,['-e',${JSON.stringify(CLOSE_MEMBER)},join(custody,'child.json'),join(temporary,'member-exit.json')],{stdio:['ignore','pipe','ignore']}):member(30000);
  await once(retained,'spawn');
  if(retained.stdout)await once(retained.stdout,'data');
  publish(${JSON.stringify(GROUP_MEMBER_RECORD)},{pid:retained.pid,birth:await processBirth(retained.pid)});
}
// The early-exit leaf ends before readiness, so readiness waits must fail fast.
if(mode==='early-exit')process.exit(23);
if(mode==='retire')await import('./platform/test/trusted-docker-fake-setup.mjs');
publish('child-ready.json',{pid:process.pid,birth:await processBirth(process.pid)});
process.stdout.write('fixture-begin\\n');
await (mode==='release-early'?new Promise(resolve=>setTimeout(resolve,500)).then(watchRelease):held);
if(mode==='output-failed')process.stdout.write(Buffer.alloc(8192,120));
process.stdout.write('fixture-end\\n');
if(process.env.HTTP_PROXY!==undefined){
  const proxy=new URL(process.env.HTTP_PROXY);
  for(const value of [process.env.HTTP_PROXY,proxy.username,decodeURIComponent(proxy.username),proxy.password,decodeURIComponent(proxy.password),Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64')]){
    process.stdout.write(value.slice(0,7));await new Promise(setImmediate);process.stdout.write(value.slice(7)+'\\n');
  }
}
process.stderr.write('fixture-error\\n');
if(process.env.HTTP_PROXY!==undefined)process.stderr.write(process.env.HTTP_PROXY+'\\n');
process.exitCode=${mode === 'output-failed' ? '0' : '17'};
`,
  );
  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '--quiet',
      '-m',
      'test: owned custody fixture',
    ],
  ]) {
    const result = budget.run('git', 'git', args, {
      cwd: repository,
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (result.status !== 0) throw new Error('Could not create owned custody repository');
  }
  const head = budget
    .run('git', 'git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    })
    .stdout.trim();
  return head;
}

function recordedProcesses(temporary: string) {
  return [GROUP_MEMBER_RECORD, FAKE_PLATFORM_RECORD].flatMap((name) => {
    const path = join(temporary, name);
    if (!existsSync(path)) return [];
    const identity: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return [record(identity)];
  });
}

function fixtureProcessCustody(
  environment: NodeJS.ProcessEnv,
  directory: string,
  budget: CaseBudget,
) {
  const closures = new Map<number, { closed: boolean }>();
  const observeProcess = (pid: number): string | null => {
    const source = `import {liveProcessBirth} from ${JSON.stringify(birthModule)};process.stdout.write(JSON.stringify(await liveProcessBirth(Number(process.argv[1]))));`;
    const args = ['--input-type=module', '-e', source, String(pid)];
    const result = budget.run('process observation', process.execPath, args, {
      env: { ...environment, LANG: 'C.UTF-8' },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65_536,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Fixture process observation unavailable: pid=${String(pid)} present=${String(ownerPresent(pid))}`,
      );
    const value: unknown = JSON.parse(result.stdout);
    if (value !== null && typeof value !== 'string')
      throw new Error('Invalid fixture process observation');
    return value;
  };
  const settle = async (
    identity: Record<string, unknown>,
    group: boolean,
    signal: NodeJS.Signals = 'SIGKILL',
  ) => {
    const pid = identity.pid;
    if (typeof pid !== 'number' || typeof identity.birth !== 'string')
      throw new Error('Invalid owned fixture identity');
    const live = () => {
      const current = observeProcess(pid);
      if (current !== null && current !== identity.birth)
        throw new Error('Fixture identity changed; retaining authority');
      return current !== null;
    };
    const waitForAbsence = async () => {
      const since = Date.now();
      const until = since + budget.limit('process retirement', 5000);
      for (;;) {
        // A synchronous observer can see Darwin ESRCH while this parent's child is
        // still unreaped. Its group may return EPERM until the actual close event.
        if (!live() && closures.get(pid)?.closed !== false && (!group || groupIsAbsent(pid)))
          return;
        if (Date.now() >= until)
          throw budget.stalled('Owned custody fixture process did not retire', since, pid, group);
        await delay(20);
      }
    };
    if (!live()) return waitForAbsence();
    if (group) {
      const observed = budget.run('process group', '/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 65_536,
      });
      if (!live()) return waitForAbsence();
      if (observed.status !== 0 || observed.stdout.trim() !== String(pid))
        throw new Error('Owned fixture process group identity changed');
    }
    try {
      process.kill(group ? -pid : pid, signal);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
    }
    await waitForAbsence();
  };
  const groups: Record<string, unknown>[] = [];
  const track = async (child: ChildProcess) => {
    const closure = { closed: false };
    child.once('close', () => {
      closure.closed = true;
    });
    await once(child, 'spawn');
    try {
      if (child.pid === undefined) throw new Error('Missing owned fixture process');
      closures.set(child.pid, closure);
      const birth = observeProcess(child.pid);
      if (birth === null) throw new Error('Owned fixture process exited before registration');
      const identity = Object.freeze({ pid: child.pid, birth });
      groups.push(identity);
      writeFileSync(join(directory, 'fixture-processes.json'), JSON.stringify(groups), {
        mode: 0o600,
      });
      return identity;
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
      throw error;
    }
  };
  const cleanup = async () => {
    const failures: unknown[] = [];
    for (const identity of groups) {
      try {
        await settle(identity, true);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Owned fixture observers did not retire');
  };
  return { observeProcess, settle, track, cleanup };
}

function launchCustodyObserver(
  repository: string,
  environment: NodeJS.ProcessEnv,
  head: string,
  budget: CaseBudget,
) {
  // Under a case deadline the inner start ends a second before the outer publication, so the two
  // fail distinguishably; without one both keep their original 15s.
  const outer = budget.limit('observer publication', 15_000);
  const inner = Number.isFinite(budget.deadline) ? Math.max(1, outer - 1000) : outer;
  const source = `const {spawnSync}=require('node:child_process');
const result=spawnSync('pnpm',['--silent','verify:docker','start',${JSON.stringify(head)}],{cwd:${JSON.stringify(repository)},encoding:'utf8',timeout:${String(inner)}});
process.stdout.write(JSON.stringify({status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.code})+String.fromCharCode(10));
setInterval(()=>{},1000);`;
  const observer = spawn(process.execPath, ['-e', source], {
    cwd: repository,
    env: { ...environment, LANG: 'C.UTF-8' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { observer, outer, inner };
}

/** The observer's single published start row, bounded by its own publication deadline. */
async function observerPublication(
  { observer, outer, inner }: ReturnType<typeof launchCustodyObserver>,
  budget: CaseBudget,
) {
  const since = Date.now();
  const lines = createInterface({ input: observer.stdout });
  const ready = Promise.withResolvers<string>();
  lines.once('line', ready.resolve);
  observer.once('close', () => {
    ready.reject(new Error('Owned observer closed before publication'));
  });
  observer.stderr.resume();
  const deadline = setTimeout(() => {
    ready.reject(budget.stalled('Owned observer publication deadline', since, observer.pid));
  }, outer);
  let row: string;
  try {
    row = await ready.promise;
  } finally {
    clearTimeout(deadline);
    lines.close();
  }
  const parsed: unknown = JSON.parse(row);
  const value = record(parsed);
  if (
    (value.status !== null && typeof value.status !== 'number') ||
    typeof value.stdout !== 'string' ||
    typeof value.stderr !== 'string'
  )
    throw new Error('Invalid owned observer publication');
  if (value.error === 'ETIMEDOUT')
    throw budget.stalled(`Observer inner start timeout ${String(inner)}ms`, since, observer.pid);
  return { status: value.status, stdout: value.stdout, stderr: value.stderr };
}

function launchCustodySentinel(directory: string, environment: NodeJS.ProcessEnv) {
  const ready = join(directory, 'sentinel-ready');
  const interrupted = join(directory, 'sentinel-interrupted');
  const source = `const fs=require('node:fs');
process.once('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(interrupted)},'SIGINT');process.exit(31);});
fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', source], {
    cwd: directory,
    env: { ...environment, LANG: 'C.UTF-8' },
    detached: true,
    stdio: 'ignore',
  });
  return { child, ready, interrupted };
}

/** The authority of an invocation whose start died before capture, read once its owner is gone. */
function uncapturedAuthority(root: string, owner: Readonly<Record<string, unknown>>) {
  const request = record(JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')));
  const temporary = realpathSync(String(request.temporary));
  const { dev, ino } = lstatSync(temporary);
  const childPath = join(root, 'child.json');
  const child = existsSync(childPath)
    ? {
        child: Object.freeze({
          ...record(record(JSON.parse(readFileSync(childPath, 'utf8'))).owner),
        }),
      }
    : {};
  return { owner, temporary, device: dev, inode: ino, ...child };
}

function fixtureDirectories() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-team-docker-custody-')));
  const repository = join(directory, 'repository');
  const home = join(directory, 'home');
  for (const path of [repository, home]) mkdirSync(path);
  return { directory, repository, home };
}

function createTrustedDockerFixture(mode: CustodyMode, scenario?: RetirementScenario, at?: number) {
  const { directory, repository, home } = fixtureDirectories();
  const environment = {
    PATH: process.env.PATH,
    HOME: home,
    // Only the complete-output case supplies a proxy; held-output fences have no secret tail.
    HTTP_PROXY: mode === 'fail' ? CUSTODY_PROXY : undefined,
  };
  const budget = caseBudget(at);
  const processes = fixtureProcessCustody(environment, directory, budget);
  const { observeProcess, settle } = processes;
  const head = prepareCustodyRepository(repository, environment, mode, budget, scenario);
  const entry = join(repository, 'scripts/trusted-docker-run.mjs');
  const command = (args: string[], wrapper = false, extraEnvironment: NodeJS.ProcessEnv = {}) => {
    const executable = wrapper ? 'pnpm' : process.execPath;
    const commandArguments = wrapper ? ['--silent', 'verify:docker', ...args] : [entry, ...args];
    return budget.run(
      `command ${args[0] ?? ''}`,
      mode === 'output-failed' ? 'python3' : executable,
      mode === 'output-failed'
        ? ['-c', FILE_SIZE_LIMIT_PROGRAM, executable, ...commandArguments]
        : commandArguments,
      {
        cwd: repository,
        env: {
          ...environment,
          GH_TOKEN: 'fixture-gh-custody-canary',
          DMXAPI_KEY: 'fixture-model-custody-canary',
          SSH_AUTH_SOCK: '/fixture-ssh-custody-canary',
          ...extraEnvironment,
        },
        encoding: 'utf8',
        timeout: 15_000,
        killSignal: 'SIGKILL',
        maxBuffer: 65_536,
      },
    );
  };
  const custodyBase = join(home, '.local/share/dsh-team/docker-verification');
  const issued = new Map<
    string,
    {
      owner: Record<string, unknown>;
      child?: Record<string, unknown>;
      temporary: string;
      device: number;
      inode: number;
    }
  >();
  const captureStart = async (
    result: Pick<ReturnType<typeof command>, 'status' | 'stdout' | 'stderr'>,
  ) => {
    if (result.status !== 0) return result;
    const value: unknown = JSON.parse(result.stdout);
    const invocation = record(value).invocation;
    if (typeof invocation !== 'string' || !/^[a-f0-9-]{36}$/.test(invocation))
      throw new Error('Invalid issued fixture invocation');
    const invocationRoot = join(custodyBase, invocation);
    const requested: unknown = JSON.parse(
      readFileSync(join(invocationRoot, 'request.json'), 'utf8'),
    );
    const request = record(requested);
    if (
      request.head !== head ||
      request.root !== repository ||
      typeof request.temporary !== 'string'
    )
      throw new Error('Fixture launch authority changed');
    const temporary = realpathSync(request.temporary);
    if (!temporary.startsWith(join(realpathSync('/tmp'), 'dsh-team-docker-')))
      throw new Error('Unexpected fixture temporary root');
    const temporaryIdentity = lstatSync(temporary);
    if (!temporaryIdentity.isDirectory() || temporaryIdentity.uid !== process.getuid?.())
      throw new Error('Unowned fixture temporary root');
    const launched: unknown = JSON.parse(readFileSync(join(invocationRoot, 'launch.json'), 'utf8'));
    const authority = {
      owner: Object.freeze({ ...record(record(launched).owner) }),
      temporary,
      device: temporaryIdentity.dev,
      inode: temporaryIdentity.ino,
    };
    issued.set(invocation, authority);
    const since = Date.now();
    const until = since + budget.limit('command identity', 10_000);
    const childPath = join(invocationRoot, 'child.json');
    while (!existsSync(childPath) && !existsSync(join(invocationRoot, 'result.json'))) {
      if (Date.now() >= until)
        throw budget.stalled('Command identity unpublished', since, authority.owner.pid);
      await delay(20);
    }
    if (existsSync(childPath)) {
      const child: unknown = JSON.parse(readFileSync(childPath, 'utf8'));
      issued.set(invocation, {
        ...authority,
        child: Object.freeze({ ...record(record(child).owner) }),
      });
    }
    return result;
  };
  const start = (extraEnvironment: NodeJS.ProcessEnv = {}) =>
    captureStart(command(['start', head], true, extraEnvironment));
  const startObserved = async () => {
    const launched = launchCustodyObserver(repository, environment, head, budget);
    const identity = await processes.track(launched.observer);
    const started = await captureStart(await observerPublication(launched, budget));
    return { started, identity, disconnect: () => settle(identity, true, 'SIGTERM') };
  };
  const startSentinel = async () => {
    const sentinel = launchCustodySentinel(directory, environment);
    const identity = await processes.track(sentinel.child);
    return { identity, ready: sentinel.ready, interrupted: sentinel.interrupted };
  };
  const killOwner = async (invocation: string) => {
    const authority = issued.get(invocation);
    if (!authority) throw new Error('Missing issued fixture owner');
    await settle(authority.owner, false);
  };
  const cleanup = async () => {
    budget.reserve();
    const failures: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
        return true;
      } catch (error) {
        failures.push(error);
        return false;
      }
    };
    const names = existsSync(custodyBase) ? readdirSync(custodyBase) : [];
    const uncaptured = names.filter((name) => !issued.has(name));
    if (uncaptured.length)
      failures.push(new Error('Uncaptured custody fixture authority retained'));
    // A start killed at the deadline never captured its owner: settle that owner first, so it can
    // launch no command after child.json is read, then retire it like a captured invocation.
    for (const name of uncaptured)
      await attempt(async () => {
        const root = join(custodyBase, name);
        const launched = record(JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8')));
        const owner = Object.freeze({ ...record(launched.owner) });
        await settle(owner, false);
        issued.set(name, uncapturedAuthority(root, owner));
      });
    for (const authority of issued.values()) {
      // Retire recorded members and the detached platform before the group is observed absent.
      const memberSettled = await attempt(async () => {
        for (const identity of recordedProcesses(authority.temporary))
          await settle(identity, false);
      });
      const childSettled = await attempt(async () => {
        if (authority.child) await settle(authority.child, true);
      });
      const ownerSettled = await attempt(() => settle(authority.owner, false));
      if (memberSettled && childSettled && ownerSettled)
        await attempt(() => {
          if (!existsSync(authority.temporary)) return;
          const current = lstatSync(authority.temporary);
          if (
            !current.isDirectory() ||
            current.dev !== authority.device ||
            current.ino !== authority.inode
          )
            throw new Error('Fixture temporary root identity changed');
          rmSync(authority.temporary, { recursive: true, force: true });
        });
    }
    await attempt(processes.cleanup);
    if (failures.length !== 0)
      throw new AggregateError(failures, 'Owned custody fixture cleanup unconfirmed');
    rmSync(directory, { recursive: true, force: true });
  };
  return {
    directory,
    repository,
    home,
    head,
    deadline: budget.deadline,
    command,
    inspect: (args: string[]) => budget.unbounded(() => command(args)),
    start,
    startObserved,
    startSentinel,
    killOwner,
    observeProcess,
    cleanup,
  };
}

export async function withTrustedDockerFixture(
  mode: CustodyMode,
  run: (fixture: ReturnType<typeof createTrustedDockerFixture>) => void | Promise<void>,
  scenario?: RetirementScenario,
  deadline?: number,
) {
  const fixture = createTrustedDockerFixture(mode, scenario, deadline);
  const failures: unknown[] = [];
  try {
    await run(fixture);
  } catch (error) {
    failures.push(error);
  }
  try {
    await fixture.cleanup();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 1)
    throw new AggregateError(failures, 'Custody scenario and cleanup failed', {
      cause: failures[0],
    });
  if (failures.length === 1) throw failures[0];
}
