import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

const verifier = resolve(import.meta.dirname, '../../scripts/verify-browser-runtime.mjs');
const executable = String.raw`import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
if(basename(process.argv[1])==='pnpm'){state.verificationStarted=true;process.exitCode=8;}
else if(args[0]==='--user')process.stdout.write('LoadState=not-found\n');
else if(args[0]==='info')process.stdout.write(JSON.stringify({OSType:'linux',Architecture:'amd64',SecurityOptions:[]}));
else if(args[0]==='build') {
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
  const result = spawnSync(
    process.execPath,
    ['--import', preload, worker, 'finalize-locked', invocation],
    { env: { HOME: root, PATH: join(root, 'bin') }, encoding: 'utf8', timeout: 10_000 },
  );
  if (result.error || result.signal !== null) throw new Error('Owned finalizer did not settle');
  return {
    exit: result.status,
    output: result.stdout + result.stderr,
    final: await optionalJson(join(workerRoot, 'final.json')),
  };
}

export async function runBrowserBuildFailure(
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
  const canary = `private-${randomUUID()}`;
  try {
    const bin = join(root, 'bin');
    const temporary = join(root, 'tmp');
    const chrome = join(root, 'chrome');
    await Promise.all([mkdir(bin), mkdir(temporary), mkdir(chrome)]);
    const tool = join(root, 'docker.mjs');
    await writeFile(tool, `#!${process.execPath}\n${executable}`, { mode: 0o700 });
    await symlink(tool, join(bin, 'docker'));
    await symlink(tool, join(bin, 'pnpm'));
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
};syncBuiltinESMExports();`,
    );
    const result = spawnSync(process.execPath, ['--import', preload, verifier, 'docker'], {
      env: {
        PATH: bin,
        HOME: root,
        TMPDIR: temporary,
        CHROME_BIN: join(chrome, 'chrome-headless-shell'),
        ...(artifactRuntime === undefined ? {} : { DSH_TEAM_VERIFICATION_IMAGES: artifactRuntime }),
      },
      encoding: 'utf8',
      timeout: 10_000,
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
    const rescued = rescue ? await finalizeFailedBuild(root, directory, tool, rescue) : undefined;
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
