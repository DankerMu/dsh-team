import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const worker = resolve(import.meta.dirname, 'ci-vps-worker.ts');

// One owned executable plays git, pnpm and systemctl. It sees only the worker's restricted
// environment, so its scenario comes from $HOME/fixture.json and its calls go to calls.jsonl.
const tool = String.raw`const {appendFileSync,readFileSync,writeFileSync}=require('node:fs');
const {basename,join}=require('node:path');
const name=basename(process.argv[1]);const args=process.argv.slice(2);
if(name==='systemctl')process.stdout.write('LoadState=not-found\n');
else {
 const home=process.env.HOME;const state=JSON.parse(readFileSync(join(home,'fixture.json'),'utf8'));
 appendFileSync(join(home,'calls.jsonl'),JSON.stringify({name,args,env:process.env})+'\n');
 const step=name+' '+args[0];
 if(step==='git rev-parse')process.stdout.write((state.mode==='identity-mismatch'?'b'.repeat(40):state.sha)+'\n');
 else {
  process.stdout.write('stdout '+state.output+'\n');process.stderr.write('stderr '+state.output+'\n');
  if(step==='pnpm test:model'){
   const key=process.env.DMXAPI_KEY;process.stdout.write('key '+key+'\n');process.stderr.write('key '+key+'\n');
   process.exitCode=state.mode==='driver-nonzero'?3:0;
  } else if(step==='git fetch'&&state.mode==='checkout-nonzero')process.exitCode=1;
  else if(step==='pnpm install'&&state.mode==='install-nonzero')process.exitCode=7;
  else if(step==='pnpm build'){
   if(state.mode==='build-signal')process.kill(process.pid,'SIGKILL');
   else if(state.mode==='build-output-limit')process.stdout.write('x'.repeat(17*1024*1024));
   else if(['build-timeout','build-interrupted'].includes(state.mode)){
    writeFileSync(join(home,'build.pid'),String(process.pid));setInterval(()=>{},1000);
   }
  }
 }
}
`;

export type WorkerMode =
  | 'checkout-nonzero'
  | 'install-nonzero'
  | 'build-signal'
  | 'build-timeout'
  | 'build-output-limit'
  | 'checkout-spawn-error'
  | 'identity-mismatch'
  | 'checkout-unknown'
  | 'admission-expired'
  | 'admission-cancelled'
  | 'invalid-approval'
  | 'build-interrupted'
  | 'driver-success'
  | 'driver-nonzero';

type ExecutionReplacement = { text: string; mode: number } | 'absent' | 'symlink';

interface WorkerRun {
  finalize?: boolean;
  execution?: ExecutionReplacement;
}

interface Receipt {
  text: string;
  value: unknown;
  regular: boolean;
  mode: number;
}

async function receipt(path: string): Promise<Receipt | undefined> {
  try {
    const info = await lstat(path);
    const text = info.isFile() ? await readFile(path, 'utf8') : '';
    return {
      text,
      value: info.isFile() ? (JSON.parse(text) as unknown) : undefined,
      regular: info.isFile(),
      mode: info.mode & 0o777,
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence; EPERM (for example an unreaped zombie) is still present.
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    return true;
  }
}

/** Bounded absence observation for the blocking fake after its owner settled. */
async function survives(pidFile: string) {
  const text = await optionalText(pidFile);
  if (text === undefined) return false;
  const pid = Number(text);
  const until = Date.now() + 5_000;
  while (alive(pid) && Date.now() < until) await delay(50);
  if (!alive(pid)) return false;
  process.kill(pid, 'SIGKILL');
  return true;
}

/** Runs one real worker entry in its own process group; interrupt kills that whole group. */
async function runEntry(
  args: string[],
  env: Record<string, string>,
  interruptWhen?: () => Promise<boolean>,
) {
  const child = spawn(process.execPath, args, {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<number | null>((settle, reject) => {
    child.once('error', reject);
    child.once('close', settle);
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk: Buffer) => {
      if (output.length < 65_536) output += chunk.toString('utf8');
    });
  const killGroup = () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
      process.kill(-child.pid, 'SIGKILL');
  };
  const timer = setTimeout(killGroup, 20_000);
  try {
    if (interruptWhen) {
      const until = Date.now() + 15_000;
      while (!(await interruptWhen())) {
        if (Date.now() > until) throw new Error('Owned worker never reached its interrupt point');
        await delay(25);
      }
      killGroup();
    }
    return { exit: await closed, output };
  } finally {
    clearTimeout(timer);
    killGroup();
  }
}

async function replaceExecution(directory: string, replacement: ExecutionReplacement) {
  const file = join(directory, 'execution.json');
  await rm(file, { force: true });
  if (replacement === 'absent') return;
  if (replacement === 'symlink') {
    await writeFile(join(directory, 'elsewhere.json'), '{"exitCode":0}', { mode: 0o600 });
    await symlink('elsewhere.json', file);
    return;
  }
  await writeFile(file, replacement.text, { mode: replacement.mode });
}

export async function runWorkerScenario(mode: WorkerMode, options: WorkerRun = {}) {
  if (await exists(join(dirname(process.execPath), 'pnpm')))
    throw new Error('A real pnpm beside node would shadow the owned driver fake');
  const root = await mkdtemp(join(tmpdir(), 'dsh-worker-phase-'));
  const invocation = randomUUID();
  const directory = join(root, '.local/share/dsh-team/ci', invocation);
  const bin = join(root, '.local/share/dsh-team/toolchain/pnpm-10.34.6/node_modules/.bin');
  const canaries = {
    sha: randomBytes(20).toString('hex'),
    output: `output-${randomUUID()}`,
    path: `absent-${randomUUID()}`,
    proxy: `http://proxy-${randomUUID()}.invalid:3128`,
    key: `key-${randomUUID()}`,
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(bin, { recursive: true });
    await mkdir(join(root, '.config/dsh-team'), { recursive: true });
    await writeFile(join(root, '.config/dsh-team/env'), `DMXAPI_KEY=${canaries.key}\n`, {
      mode: 0o600,
    });
    await writeFile(join(root, 'tool.cjs'), `#!${process.execPath}\n${tool}`, { mode: 0o700 });
    for (const name of ['git', 'pnpm', 'systemctl'])
      await symlink(join(root, 'tool.cjs'), join(bin, name));
    await writeFile(join(root, 'fixture.json'), JSON.stringify({ mode, ...canaries }));
    const expired = mode === 'admission-expired';
    await writeFile(
      join(directory, 'approval.json'),
      JSON.stringify({
        repository: mode === 'invalid-approval' ? 'foreign/repository' : 'DankerMu/dsh-team',
        repositoryId: '1',
        ownerId: '2',
        actorId: '2',
        sha: canaries.sha,
        workflowSha: canaries.sha,
        ref: 'refs/heads/codex/worker-fixture',
        workflowRef:
          'DankerMu/dsh-team/.github/workflows/model.yml@refs/heads/codex/worker-fixture',
        audience: `dsh-team-vps:${invocation}`,
        expiresAt: Math.floor(Date.now() / 1000) + (expired ? -60 : 600),
      }),
      { mode: 0o600 },
    );
    if (!expired)
      await writeFile(join(directory, 'admitted.json'), '{"startedAt":0}', { mode: 0o600 });
    // A pre-existing checkout makes the worker's own exclusive mkdir fail outside any command.
    if (mode === 'checkout-unknown') await mkdir(join(directory, 'checkout'));
    if (mode === 'admission-cancelled')
      await writeFile(join(directory, 'cancel'), '', { mode: 0o600 });
    const routes = {
      git: mode === 'checkout-spawn-error' ? join(root, canaries.path) : join(bin, 'git'),
      pnpm: join(bin, 'pnpm'),
      systemctl: join(bin, 'systemctl'),
    };
    const preload = join(root, 'host.mjs');
    // Only the host platform and the external executable boundary are adapted.
    await writeFile(
      preload,
      `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'linux'});
const routes=${JSON.stringify(routes)};const original=cp.spawnSync;
// Fixture-only deadline compression for the build step; the worker still declares its own value.
const shorten=${JSON.stringify(mode === 'build-timeout')};
cp.spawnSync=(binary,args,options)=>original(Object.hasOwn(routes,binary)?routes[binary]:binary,args,shorten&&binary==='pnpm'&&args[0]==='build'?{...options,timeout:200}:options);
syncBuiltinESMExports();`,
    );
    const env = {
      HOME: root,
      PATH: '/usr/bin:/bin',
      HTTP_PROXY: canaries.proxy,
      HTTPS_PROXY: canaries.proxy,
    };
    const pidFile = join(root, 'build.pid');
    const executed = await runEntry(
      ['--import', preload, worker, 'execute', invocation],
      env,
      mode === 'build-interrupted'
        ? async () => (await optionalText(pidFile)) !== undefined
        : undefined,
    );
    const survivor = await survives(pidFile);
    const phase = await receipt(join(directory, 'phase.json'));
    const execution = await receipt(join(directory, 'execution.json'));
    if (options.execution) await replaceExecution(directory, options.execution);
    const finalized = options.finalize
      ? await runEntry(['--import', preload, worker, 'finalize-locked', invocation], env)
      : undefined;
    const calls = (await optionalText(join(root, 'calls.jsonl'))) ?? '';
    return {
      canaries,
      executed,
      finalized,
      survivor,
      phase,
      execution,
      final: await receipt(join(directory, 'final.json')),
      log: await optionalText(join(directory, 'execution.log')),
      calls: calls
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const value = JSON.parse(line) as { name: string; args: string[] }; // Fixture-owned call record.
          return { name: value.name, args: value.args };
        }),
      callText: calls,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
