import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
  realpath,
  readlink,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '../..');

const tool = String.raw`import { basename, join } from 'node:path';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
const root = process.env.FIXTURE_ROOT;
const mode = process.env.FIXTURE_MODE;
const invocation = process.env.FIXTURE_INVOCATION;
const canary = process.env.FIXTURE_CANARY;
const observing = process.env.FIXTURE_OBSERVER === '1';
const sha = 'a'.repeat(40);
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
const host = join(root, 'host');
const remoteBase = '/home/ubuntu/.local/share/dsh-team/ci';
const remote = remoteBase + '/' + invocation;
const own = join(host, invocation);
// FIXTURE_FINAL carries exact worker-produced final.json bytes when a case supplies them.
const finalText = process.env.FIXTURE_FINAL ?? JSON.stringify(mode === 'cleanup-failed'
  ? {vpsCleanupComplete: false, failures: ['docker-rescue'], exitCode: 0}
  : {vpsCleanupComplete: true, failures: [], exitCode: 1});
const final = JSON.parse(finalText);
const event = (kind) => appendFileSync(join(root, 'events.jsonl'), JSON.stringify({kind}) + '\n');
function output(value) { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); }
function mappedShell(command) {
  const mapped = command.replaceAll(remoteBase, host);
  const result = spawnSync('/bin/sh', ['-c', mapped], {env:{PATH:'/usr/bin:/bin'}, encoding:'utf8'});
  output(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
}
if (name === 'git') {
  if (args[0] === 'rev-parse') output(sha + '\n');
  else if (args[0] === 'archive') output('fixture archive boundary');
  else if (args[0] !== 'push') process.exit(91);
} else if (name === 'ssh-keygen') {
  const path = args[args.indexOf('-f') + 1];
  const keys = generateKeyPairSync('ed25519');
  writeFileSync(path, keys.privateKey.export({type:'pkcs8',format:'pem'}), {mode:0o600});
  writeFileSync(path + '.pub', 'ssh-ed25519 fixture-public\n', {mode:0o600});
} else if (name === 'gh') {
  const marker = join(root, 'github-secret-present');
  if (args[0] === 'api' && args[1] === 'repos/DankerMu/dsh-team') output({full_name:'DankerMu/dsh-team',id:1,owner:{login:'DankerMu',id:2}});
  else if (args[0] === 'api' && args[1].includes('/actions/secrets/')) {
    if (existsSync(marker)) output({});
    else {process.stderr.write('(HTTP 404)');process.exit(1);}
  } else if (args[0] === 'secret' && args[1] === 'set') {readFileSync(0);writeFileSync(marker,'published');event('github-published');}
  else if (args[0] === 'secret' && args[1] === 'delete') {rmSync(marker,{force:true});event('github-retired');}
  else if (args[0] === 'api' && args[1].includes('/actions/runs?')) output([{id:37,head_sha:sha,head_branch:'codex/owner-fixture',path:'.github/workflows/model.yml',status:'in_progress'}]);
  else if (args[0] === 'run' && args[1] === 'watch') process.exit(1);
  else if (args[0] === 'run' && args[1] === 'view') output('completed\n');
  else if (args[0] === 'run' && args[1] === 'cancel') event('actions-cancelled');
  else process.exit(92);
} else if (name === 'ssh') {
  if (args[0] === '-G') output('hostname fixture.invalid\nuser fixture\nport 22\n');
  else {
    const command = args.at(-1);
    if (command.includes('cat /etc/ssh/ssh_host_ed25519_key.pub')) output('ssh-ed25519 fixture-host-public\n');
    else if (command.includes('mkdir -p ' + remoteBase)) {mkdirSync(own,{recursive:true,mode:0o700});writeFileSync(join(own,'owner'),invocation,{mode:0o600});event('host-created');}
    else if (command.includes('tar -xf')) {readFileSync(0);event('worker-installed');}
    else if (command.includes('cat >')) {readFileSync(0);event('private-input-delivered');}
    else if (command.includes(' await ') || command.includes(' await-retirement ')) {
      const countFile=join(root,'await-count');
      const count=existsSync(countFile)?Number(readFileSync(countFile,'utf8'))+1:1;
      writeFileSync(countFile,String(count));event('await-'+count);
      if (mode === 'late-stdout') {
        if (!observing) process.exit(255);
        const remainder = JSON.stringify(final).slice(1);
        const script = "const fs=require('node:fs');const until=Date.now()+5000;const timer=setInterval(()=>{let alive=true;try{process.kill("+process.pid+",0)}catch(e){if(e.code==='ESRCH')alive=false;else process.exit(2)}if(!alive&&fs.existsSync("+JSON.stringify(join(own,'final.json'))+")){clearInterval(timer);process.stdout.write("+JSON.stringify(remainder)+",()=>process.exit(0))}else if(Date.now()>until)process.exit(3)},10)";
        const tail = spawn(process.execPath, ['-e', script], {stdio:['ignore',1,'ignore']});
        tail.unref();
        const prefix = Promise.withResolvers();
        process.stdout.write('{', prefix.resolve);
        await prefix.promise;
        event('observer-parent-exit-before-tail');
        process.exit(0);
      }
      if (observing) {
        if (mode==='observer-timeout') {setInterval(()=>{},1000);await Promise.withResolvers().promise;}
        if (mode==='observer-invalid') {output('{'+canary);process.exit(0);}
        if (mode==='observer-oversized') {output(canary.repeat(2048));process.exitCode=0;}
        else if(mode==='observer-signal') process.kill(process.pid,'SIGTERM');
        else if(['valid-execution-failure','cleanup-failed','observer-extra-fields','observer-owner-changed'].includes(mode)) {
          writeFileSync(join(own,'final.json'),finalText,{mode:0o600});
          output(mode==='observer-extra-fields'?{...final,private:canary}:finalText);
        } else {event('observer-transport-failed');process.exit(255);}
      } else {
        if(mode==='canonical-unreachable')process.exit(255);
        if(mode==='canonical-invalid')output({vpsCleanupComplete:true,failures:[],exitCode:'0',private:canary});
        else if(mode==='canonical-inconsistent')output({vpsCleanupComplete:true,failures:['docker-rescue'],exitCode:1});
        else if(mode==='canonical-oversized')output({...final,private:canary.repeat(2048)});
        else {
          if (mode==='changed-owner') writeFileSync(join(own,'owner'),'another-invocation');
          output(JSON.parse(readFileSync(join(own,'final.json'),'utf8')));
        }
      }
    } else if (command.includes('ln -sT')) {symlinkSync(invocation,join(host,'active'));event('lock-created');}
    else if (command.includes('systemd-run')) {
      event('owned-unit-requested');
      if(mode==='watcher-install-failed')process.exit(255);
    }
    else if (command.includes('authorized_keys')) event('authorization-published');
    else if (command.includes("printf absent; elif")) {
      if (mode==='foreign-owner') writeFileSync(join(own,'owner'),'another-invocation');
      event('owner-checked');mappedShell(command);
    } else if (command.includes('systemctl --user is-active')) output(mode==='cleanup-failed'?'active\n':'inactive\n');
    else if (command.includes(' finalize ')) {
      if(mode!=='canonical-missing')writeFileSync(join(own,'final.json'),finalText,{mode:0o600});
      event('canonical-final-written');
      if(mode==='observer-owner-changed')writeFileSync(join(own,'owner'),'another-invocation');
      if(mode==='foreign-lock'){rmSync(join(host,'active'));symlinkSync('foreign-invocation',join(host,'active'));}
    }
    else if (command.includes('touch ') && command.includes('/cancel')) event('cancel-requested');
    else if (command.includes('readlink ')) {
      if(mode==='owner-changed-at-unlock')writeFileSync(join(own,'owner'),'another-invocation');
      event('lock-retirement-requested');mappedShell(command);
    }
    else process.exit(93);
  }
} else process.exit(94);
`;

// Only the external observer process boundary is adapted. The owner module and its
// receipt/retirement decisions run unchanged; subprocess streams and closure are real.
const observerPreload = String.raw`import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const originalTimeout=globalThis.setTimeout;
if(process.env.FIXTURE_MODE==='observer-timeout') {
  // Fixture-only clock compression for the unchanged1850s observation bound.
  globalThis.setTimeout=(callback,ms,...args)=>originalTimeout(callback,ms===1850000?50:ms,...args);
}
const original = childProcess.spawn;
childProcess.spawn = (binary, args, options) => {
  if(binary!=='ssh'||!args.at(-1).includes(' await '))return original(binary,args,options);
  const mode=process.env.FIXTURE_MODE;
  const adjusted={...options,env:{...process.env,FIXTURE_OBSERVER:'1'}};
  const target=mode==='observer-spawn-error'?join(process.env.FIXTURE_ROOT,'missing-ssh'):binary;
  const child=original(target,args,adjusted);
  if(mode==='observer-stream-error')queueMicrotask(()=>child.stdout.destroy(new Error(process.env.FIXTURE_CANARY)));
  return child;
};
syncBuiltinESMExports();
`;

type OwnerScenario =
  | 'valid-execution-failure'
  | 'observer-error'
  | 'foreign-owner'
  | 'observer-owner-changed'
  | 'watcher-install-failed'
  | 'late-stdout'
  | 'changed-owner'
  | 'foreign-lock'
  | 'owner-changed-at-unlock'
  | 'cleanup-failed'
  | 'canonical-missing'
  | 'canonical-invalid'
  | 'canonical-inconsistent'
  | 'canonical-unreachable'
  | 'canonical-oversized'
  | 'observer-invalid'
  | 'observer-oversized'
  | 'observer-signal'
  | 'observer-extra-fields'
  | 'observer-spawn-error'
  | 'observer-stream-error'
  | 'observer-timeout';

async function optionalJson(path: string): Promise<unknown> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}

export async function runOwnerScenario(mode: OwnerScenario, hostFinal?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-owner-receipt-')));
  const invocation = randomUUID();
  const canary = randomUUID();
  const local = join(root, '.run/ci-model', invocation);
  const bin = join(root, 'bin');
  try {
    await mkdir(local, { recursive: true, mode: 0o700 });
    await mkdir(bin);
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(bin, 'tool.mjs'), `#!${process.execPath}\n${tool}`, { mode: 0o700 });
    const preload = join(bin, 'observer-preload.mjs');
    await writeFile(preload, observerPreload);
    for (const name of ['git', 'gh', 'ssh', 'ssh-keygen'])
      await symlink('tool.mjs', join(bin, name));
    const request = join(local, 'request.json');
    await writeFile(
      request,
      JSON.stringify({
        sha: 'a'.repeat(40),
        ref: 'refs/heads/codex/owner-fixture',
        invocation,
        repositoryRoot: root,
      }),
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      ['--import', preload, join(repository, 'scripts/ci-vps-owner.mjs'), request],
      {
        cwd: root,
        // All external commands are invocation-owned fixtures; no real git/gh/ssh is reachable.
        env: {
          PATH: bin,
          HOME: root,
          FIXTURE_ROOT: root,
          FIXTURE_MODE: mode,
          FIXTURE_INVOCATION: invocation,
          FIXTURE_CANARY: canary,
          ...(hostFinal === undefined ? {} : { FIXTURE_FINAL: hostFinal }),
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const completion = Promise.withResolvers<number | null>();
    child.once('error', completion.reject);
    child.once('close', completion.resolve);
    const closed = completion.promise;
    let output = '';
    const bounds = { exceeded: false };
    const stop = () => {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    };
    const timer = setTimeout(() => {
      bounds.exceeded = true;
      stop();
    }, 10_000);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(output) + chunk.length > 65_536) {
          bounds.exceeded = true;
          stop();
        } else output += chunk.toString('utf8');
      });
    }
    let exit: number | null;
    try {
      exit = await closed;
      if (bounds.exceeded) throw new Error('Owned operator fixture exceeded its bound');
    } finally {
      clearTimeout(timer);
    }
    const events = (await readFile(join(root, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const value: unknown = JSON.parse(line);
        if (
          typeof value !== 'object' ||
          value === null ||
          !('kind' in value) ||
          typeof value.kind !== 'string'
        )
          throw new Error('Invalid owned fixture event');
        return value.kind;
      });
    const lock = join(root, 'host/active');
    return {
      invocation,
      canary,
      exit,
      result: await optionalJson(join(local, 'result.json')),
      hostFinal: await optionalJson(join(root, 'host', invocation, 'final.json')),
      localFinal: await optionalJson(join(local, 'vps-final.json')),
      observation: await optionalJson(join(local, 'host-observation.json')),
      recovery: await optionalJson(join(local, 'host-recovery.json')),
      lockTarget: (await absent(lock)) ? undefined : await readlink(lock),
      githubSecretAbsent: await absent(join(root, 'github-secret-present')),
      privateKeyAbsent:
        (await absent(join(local, 'identity'))) && (await absent(join(local, 'identity.pub'))),
      events,
      output,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
