import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const worker = resolve(import.meta.dirname, 'ci-vps-worker.ts');

// One owned executable plays git, pnpm and systemctl. It sees only the worker's restricted
// environment, so its scenario comes from $HOME/fixture.json and its calls go to calls.jsonl.
const tool = String.raw`const {appendFileSync,readFileSync,renameSync,writeFileSync}=require('node:fs');
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
    // Publish atomically: build.pid existence is the interrupt signal, so it must never be partial.
    writeFileSync(join(home,'build.pid.tmp'),String(process.pid));renameSync(join(home,'build.pid.tmp'),join(home,'build.pid'));
    setInterval(()=>{},1000);
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

/**
 * Trusted host-local proxy source. `tunnel` routes the checkout to real git through an owned
 * loopback CONNECT recorder; the other kinds keep the owned executable fakes.
 */
type HostProxy = 'fields' | 'invalid-url' | 'public-mode' | 'tunnel';

interface WorkerRun {
  finalize?: boolean;
  execution?: ExecutionReplacement;
  hostProxy?: HostProxy;
}

// Real git is only admitted behind the recorder; it is never routed through PATH lookup.
const realGit = '/usr/bin/git';

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

/**
 * Bounded absence observation for the blocking fake after its owner settled. Without a pid file
 * there is no fake to observe, so the result is trivially false. A pid that is not a decimal
 * integer above 1 is a fixture error: 0, -1 or 1 would signal a process group or init.
 */
async function survives(pidFile: string) {
  const text = await optionalText(pidFile);
  if (text === undefined) return false;
  const pid = /^[1-9][0-9]*$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error('Owned build fake published an invalid pid file');
  const until = Date.now() + 5_000;
  while (alive(pid) && Date.now() < until) await delay(50);
  if (!alive(pid)) return false;
  process.kill(pid, 'SIGKILL');
  return true;
}

/** Records each CONNECT target, then refuses the tunnel so nothing leaves loopback. */
async function connectRecorder() {
  const tunnels: string[] = [];
  const server = createServer();
  server.on('connect', (request, socket) => {
    tunnels.push(request.url ?? '');
    // A client reset after refusal is still a recorded refusal, not a fixture crash.
    socket.on('error', () => {
      socket.destroy();
    });
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // A TCP listener on an IP literal always reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    tunnels,
    port,
    close: () =>
      new Promise<void>((settle) => {
        server.close(() => {
          settle();
        });
      }),
  };
}

/** Writes the private host-local source exactly as an operator would install it. */
async function installHostProxy(
  root: string,
  kind: HostProxy | undefined,
  canary: string,
  port: number | undefined,
) {
  if (kind === undefined) return undefined;
  if (kind === 'tunnel' && !(await exists(realGit)))
    throw new Error('Real git is required at /usr/bin/git');
  const credential = `verifier:${canary}`;
  const fields =
    kind === 'invalid-url'
      ? { HTTPS_PROXY: `http://${credential}@${canary}.invalid:3128` }
      : {
          HTTPS_PROXY: `http://${credential}@127.0.0.1:${String(port ?? 9)}`,
          NO_PROXY: kind === 'tunnel' ? '' : 'localhost',
        };
  await writeFile(join(root, '.config/dsh-team/docker-proxy.json'), JSON.stringify(fields), {
    mode: kind === 'public-mode' ? 0o644 : 0o600,
  });
  return fields;
}

/** Installs the host-local source; `tunnel` also starts the recorder and admits real git. */
async function hostTransport(root: string, kind: HostProxy | undefined, canary: string) {
  const recorder = kind === 'tunnel' ? await connectRecorder() : undefined;
  try {
    const fields = await installHostProxy(root, kind, canary, recorder?.port);
    return {
      fields,
      git: recorder ? realGit : undefined,
      // Network fence: real git may fetch only through the owned recorder, never directly.
      fence: recorder ? (fields?.HTTPS_PROXY ?? null) : null,
      tunnels: recorder?.tunnels ?? [],
      close: async () => {
        await recorder?.close();
      },
    };
  } catch (error) {
    await recorder?.close();
    throw error;
  }
}

interface Routes {
  git: string | undefined;
  absent: string;
  bin: string;
  fence: string | null;
}

/** Only the host platform and the external executable boundary are adapted. */
async function writePreload(root: string, mode: WorkerMode, selected: Routes) {
  const routes = {
    git:
      selected.git ??
      (mode === 'checkout-spawn-error' ? selected.absent : join(selected.bin, 'git')),
    pnpm: join(selected.bin, 'pnpm'),
    systemctl: join(selected.bin, 'systemctl'),
  };
  const preload = join(root, 'host.mjs');
  await writeFile(
    preload,
    `import cp from 'node:child_process';import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'linux'});os.platform=()=>'linux';
const routes=${JSON.stringify(routes)};const original=cp.spawnSync;
// Fixture-only deadline compression for the build step; the worker still declares its own value.
const shorten=${JSON.stringify(mode === 'build-timeout')};
const fence=${JSON.stringify(selected.fence)};
cp.spawnSync=(binary,args,options)=>fence!==null&&binary==='git'&&args[0]==='fetch'&&options?.env?.HTTPS_PROXY!==fence
 ?original(process.execPath,['-e','process.exit(97)'],options)
 :original(Object.hasOwn(routes,binary)?routes[binary]:binary,args,shorten&&binary==='pnpm'&&args[0]==='build'?{...options,timeout:200}:options);
syncBuiltinESMExports();`,
  );
  return preload;
}

/** Projects each fixture-owned call record to its name, arguments and proxy-named environment. */
function parseCalls(text: string) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const value = JSON.parse(line) as {
        name: string;
        args: string[];
        env: Record<string, string>;
      };
      const proxy = Object.entries(value.env).filter(([name]) => /proxy/i.test(name));
      return { name: value.name, args: value.args, proxy: Object.fromEntries(proxy) };
    });
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
    hostProxy: `host-${randomUUID()}`,
  };
  let transport: Awaited<ReturnType<typeof hostTransport>> | undefined;
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
    transport = await hostTransport(root, options.hostProxy, canaries.hostProxy);
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
    const preload = await writePreload(root, mode, {
      git: transport.git,
      absent: join(root, canaries.path),
      bin,
      fence: transport.fence,
    });
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
      hostProxy: transport.fields,
      tunnels: transport.tunnels,
      gitConfig: await optionalText(join(directory, 'checkout/.git/config')),
      executed,
      finalized,
      survivor,
      phase,
      execution,
      final: await receipt(join(directory, 'final.json')),
      log: await optionalText(join(directory, 'execution.log')),
      calls: parseCalls(calls),
      callText: calls,
    };
  } finally {
    await transport?.close();
    await rm(root, { recursive: true, force: true });
  }
}
