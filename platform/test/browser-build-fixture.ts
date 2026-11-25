import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { processIdentity } from '../../scripts/probe-browser-native.mjs';
import { caseSpawn } from './case-budget-fixture.ts';
import type { CaseSpawn } from './case-budget-fixture.ts';
import { vitestSpawnInterception } from './vitest-stand-in-fixture.ts';

const native = new URL('../../scripts/probe-browser-native.mjs', import.meta.url).href;
// After the last child: receipt reads, a cut's descendant check and kill, the root's removal.
const RESERVE_MS = 5000;
const verifier = resolve(import.meta.dirname, '../../scripts/verify-browser-runtime.mjs');
const executable = String.raw`import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processBirth } from ${JSON.stringify(native)};
const root=dirname(fileURLToPath(import.meta.url));
const file=join(root,'daemon.json');
const state=JSON.parse(readFileSync(file,'utf8'));
const args=process.argv.slice(2);
const id='sha256:'+'a'.repeat(64);
if(state.mode==='changed-after-publication'&&!state.rescuing&&args[0]==='image') {
 const receipt=JSON.parse(readFileSync(join(dirname(process.env.DOCKER_CONFIG),'image.json'),'utf8'));
 if(receipt.cleanup?.image==='blocked')state.tagChanged=true;
}
state.calls.push(args);
const save=()=>{writeFileSync(file+'.pending',JSON.stringify(state));renameSync(file+'.pending',file);};
if(args[0]==='--user')process.stdout.write('LoadState=not-found\n');
else if(args[0]==='info')process.stdout.write(JSON.stringify({OSType:'linux',Architecture:'amd64',SecurityOptions:[]}));
else if(args[0]==='build') {
 // A build can outlive its killed verifier: record who it is before it can hang. A failed
 // self-observation records no birth (never killed after a cut) and leaves the build unchanged.
 const birth=await processBirth(process.pid).catch(()=>null);
 appendFileSync(join(root,'descendants.jsonl'),JSON.stringify({pid:process.pid,birth})+'\n');
 if(state.mode==='absent'){
  // The invocation-private build context is runtime-selected; load its delivered import closure.
  const context=args.find(value=>value.startsWith('browser-runtime=')).slice('browser-runtime='.length);
  await import(pathToFileURL(join(context,'probe-browser-runtime.mjs')).href);
  state.runtimeClosureImported=true;
 }
 state.buildCount+=1;
 state.tag=args[args.indexOf('-t')+1];
 state.invocation=args[args.indexOf('--label')+1].split('=')[1];
 state.imagePresent=!['absent','deadline','output-limit','signal'].includes(state.mode);
 process.stdout.write(state.canary);
 process.stderr.write('#3 [internal] load metadata for '+state.canary+'\nprivate '+state.canary+'\n');
 process.exitCode=['qualification-failed','browser-unconfirmed'].includes(state.mode)?0:7;
 const invocationDirectory=dirname(process.env.DOCKER_CONFIG);
 if(state.mode==='evidence-failed') {
  const receipt=join(invocationDirectory,'image.json');rmSync(receipt);mkdirSync(receipt,{mode:0o700});
 }
 if(state.mode==='browser-unconfirmed')writeFileSync(join(invocationDirectory,'lost.launch.json'),'{}',{mode:0o600});
 save();
 if(state.mode==='deadline')setInterval(()=>{},1000);
 if(state.mode==='output-limit')process.stdout.write(state.canary.repeat(420_000));
 if(state.mode==='signal')process.kill(process.pid,'SIGTERM');
} else if(args[0]==='image'&&args[1]==='inspect') {
 if(!state.imagePresent||state.mode==='inspect-failed') {
  process.stderr.write('Error: No such image: '+args.at(-1)+'\n');process.exitCode=1;
 } else if(args.includes('{{.Id}}')) {
  state.tagReads+=1;
  if(['missing','unreadable'].includes(state.rescueMode)) {
   process.stderr.write(state.rescueMode==='missing'?'Error: No such image: '+args.at(-1)+'\n':state.canary);
   process.exitCode=1;
  } else process.stdout.write(state.mode==='malformed-id'?state.canary:state.tagChanged||(state.mode==='changed-tag'&&state.tagReads>1)?'sha256:'+'b'.repeat(64):id);
 } else if(args.some((value)=>value.includes('.Config.Labels'))) {
  process.stdout.write(state.mode==='foreign'||state.rescueMode==='foreign'?'foreign-invocation':state.invocation);
 } else process.stdout.write('{}');
} else if(args[0]==='image'&&args[1]==='rm') {
 state.removed.push(args.at(-1));
 if(state.mode==='removal-failed')process.exitCode=1;
 else if(args.at(-1)===id)state.imagePresent=false;
 else {state.foreignImagePresent=false;process.exitCode=1;}
} else {state.unexpected=true;process.exitCode=1;}
save();
`;

/** After a cut: report each recorded stand-in still alive, killing it only if its birth matches. */
export function retireDescendants(root: string, budget: ReturnType<typeof caseSpawn>['budget']) {
  const path = join(root, 'descendants.jsonl');
  if (!existsSync(path)) return 'none recorded';
  const recorded = readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      // JSON.parse is untyped: the stand-in's own record, whose fields are checked below.
      const entry = JSON.parse(line) as { pid?: unknown; birth?: unknown };
      // A stand-in that could not observe itself recorded no birth: it is reported, never killed.
      if (entry.birth === null) return { pid: Number(entry.pid), birth: null };
      // processIdentity validates both fields; its untyped module leaves them untyped.
      const identity = processIdentity(entry);
      return { pid: Number(identity.pid), birth: String(identity.birth) };
    });
  const known = recorded.flatMap(({ pid, birth }) => (birth === null ? [] : [pid]));
  const source = `import {liveProcessBirth} from ${JSON.stringify(native)};
process.stdout.write(JSON.stringify(await Promise.all(JSON.parse(process.argv[1]).map(liveProcessBirth))));`;
  const args = ['--input-type=module', '-e', source, JSON.stringify(known)];
  // Terminal evidence keeps its own bound once the case deadline has cut the verifier.
  const observed = budget.unbounded(() =>
    budget.run('descendant identity', process.execPath, args, {
      encoding: 'utf8',
      timeout: 3000,
      killSignal: 'SIGKILL',
    }),
  );
  // The observer answers each known pid's live birth, or null once it is gone, in order.
  const births = observed.status === 0 ? (JSON.parse(observed.stdout) as unknown[]) : undefined;
  return recorded
    .map(({ pid, birth }) => {
      if (birth === null || births === undefined) return `pid=${String(pid)} unobservable`;
      const live = births[known.indexOf(pid)];
      if (live === null) return `pid=${String(pid)} gone`;
      if (live !== birth) return `pid=${String(pid)} reused, retained`;
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        // Only absence since the observation is tolerated. Any other kill error leaves the map and
        // propagates; caseSpawn then reports only its kind, as `unobservable (<name>)`.
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        return `pid=${String(pid)} gone`;
      }
      return `pid=${String(pid)} alive, killed`;
    })
    .join(', ');
}

async function optionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

type RescueMode = 'changed' | 'matching' | 'missing' | 'unreadable' | 'foreign' | 'old-built';

async function finalizeFailedBuild(
  root: string,
  directory: string,
  tool: string,
  mode: RescueMode,
  spawn: CaseSpawn,
) {
  const invocation = randomUUID();
  const workerRoot = join(root, '.local/share/dsh-team/ci', invocation);
  const workerTemporary = join(workerRoot, 'tmp');
  await mkdir(workerTemporary, { recursive: true, mode: 0o700 });
  const received = join(workerTemporary, 'dsh-browser-command-received');
  await cp(directory, received, { recursive: true });
  if (mode === 'old-built') {
    const receipt = await optionalJson(join(received, 'image.json'));
    if (typeof receipt !== 'object' || receipt === null) throw new Error('Owned receipt missing');
    Reflect.deleteProperty(receipt, 'failure');
    Reflect.deleteProperty(receipt, 'cleanup');
    await writeFile(join(received, 'image.json'), JSON.stringify({ ...receipt, state: 'built' }));
  }
  const daemonPath = join(root, 'daemon.json');
  const daemon = await optionalJson(daemonPath);
  if (typeof daemon !== 'object' || daemon === null) throw new Error('Owned daemon state missing');
  await writeFile(
    daemonPath,
    JSON.stringify({ ...daemon, rescuing: true, rescueMode: mode, tagChanged: mode === 'changed' }),
  );
  const preload = join(root, 'worker-host.mjs');
  await writeFile(
    preload,
    `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'linux'});
const original=cp.spawnSync;
cp.spawnSync=(binary,args,options)=>original(['docker','systemctl'].includes(binary)?${JSON.stringify(tool)}:binary,args,options);
syncBuiltinESMExports();`,
  );
  const worker = resolve(import.meta.dirname, 'ci-vps-worker.ts');
  const result = spawn(
    'finalizer',
    process.execPath,
    ['--import', preload, worker, 'finalize-locked', invocation],
    { env: { HOME: root, PATH: join(root, 'bin') }, encoding: 'utf8' },
  );
  if (result.error || result.signal !== null) throw new Error('Owned finalizer did not settle');
  return {
    exit: result.status,
    output: result.stdout + result.stderr,
    final: await optionalJson(join(workerRoot, 'final.json')),
  };
}

export async function runBrowserBuildFailure(
  caseMs: number,
  mode:
    | 'absent'
    | 'changed-after-publication'
    | 'owned'
    | 'removal-failed'
    | 'foreign'
    | 'changed-tag'
    | 'malformed-id'
    | 'inspect-failed'
    | 'qualification-failed'
    | 'browser-unconfirmed'
    | 'evidence-failed'
    | 'deadline'
    | 'output-limit'
    | 'spawn-failed'
    | 'signal' = 'absent',
  rescue?: RescueMode,
  artifactRuntime?: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-build-'));
  const { spawn } = caseSpawn(caseMs, RESERVE_MS, (budget) => retireDescendants(root, budget));
  const canary = `private-${randomUUID()}`;
  try {
    const bin = join(root, 'bin');
    const temporary = join(root, 'tmp');
    const chrome = join(root, 'chrome');
    await Promise.all([mkdir(bin), mkdir(temporary), mkdir(chrome)]);
    const tool = join(root, 'docker.mjs');
    await writeFile(tool, `#!${process.execPath}\n${executable}`, { mode: 0o700 });
    await symlink(tool, join(bin, 'docker'));
    await writeFile(
      join(root, 'daemon.json'),
      JSON.stringify({
        mode,
        canary,
        calls: [],
        removed: [],
        buildCount: 0,
        buildAttempts: 0,
        tagReads: 0,
        verificationStarted: false,
        foreignImagePresent: true,
      }),
    );
    await writeFile(join(chrome, 'chrome-headless-shell'), 'owned browser distribution boundary');
    await writeFile(join(chrome, 'deb.deps'), 'owned dependency manifest');
    // Any verification launch is a tripwire: record it and fail the stand-in vitest with 8.
    const vitest = join(root, 'vitest.cjs');
    await writeFile(
      vitest,
      `const fs=require('node:fs');const file=${JSON.stringify(join(root, 'daemon.json'))};
const state=JSON.parse(fs.readFileSync(file,'utf8'));state.verificationStarted=true;
fs.writeFileSync(file,JSON.stringify(state));process.exitCode=8;`,
    );
    const preload = join(root, 'host.mjs');
    // Only host qualification and the external process boundary are adapted; streams/results are real.
    await writeFile(
      preload,
      `import os from 'node:os';import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
os.platform=()=> 'linux';os.arch=()=> 'x64';process.getuid=()=>1000;
const original=cp.spawnSync;
cp.spawnSync=(binary,args,options)=>{
 if(binary!=='docker'||args[0]!=='build')return original(binary,args,options);
 const file=${JSON.stringify(join(root, 'daemon.json'))};const state=JSON.parse(fs.readFileSync(file,'utf8'));
 state.buildAttempts+=1;fs.writeFileSync(file,JSON.stringify(state));
 // Fixture-only external-call deadline compression; the verifier still declares600s.
 return original(state.mode==='spawn-failed'?${JSON.stringify(join(root, 'absent-docker'))}:binary,args,state.mode==='deadline'?{...options,timeout:50}:options);
};${vitestSpawnInterception(vitest, join(root, 'spawns.jsonl'))}syncBuiltinESMExports();`,
    );
    const result = spawn('verifier', process.execPath, ['--import', preload, verifier, 'docker'], {
      env: {
        PATH: bin,
        HOME: root,
        TMPDIR: temporary,
        CHROME_BIN: join(chrome, 'chrome-headless-shell'),
        ...(artifactRuntime === undefined ? {} : { DSH_TEAM_VERIFICATION_IMAGES: artifactRuntime }),
      },
      encoding: 'utf8',
      maxBuffer: 65_536,
    });
    if (result.error || result.signal !== null) throw new Error('Owned verifier did not settle');
    const names = await readdir(temporary);
    if (names.length !== 1 || !names[0]?.startsWith('dsh-browser-command-'))
      throw new Error('Owned verifier invocation missing');
    const directory = join(temporary, names[0]);
    const imageInfo = await stat(join(directory, 'image.json')).catch((error: unknown) => {
      if (
        artifactRuntime !== undefined &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return undefined;
      throw error;
    });
    const rescued = rescue
      ? await finalizeFailedBuild(root, directory, tool, rescue, spawn)
      : undefined;
    return {
      exit: result.status,
      rescued,
      output: result.stdout + result.stderr,
      canary,
      image: imageInfo?.isFile() ? await optionalJson(join(directory, 'image.json')) : undefined,
      imageKind: imageInfo ? (imageInfo.isFile() ? 'file' : 'other') : 'absent',
      imageMode: imageInfo ? imageInfo.mode & 0o777 : undefined,
      qualification: await optionalJson(join(directory, 'qualification.failure.json')),
      daemon: await optionalJson(join(root, 'daemon.json')),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
