import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { networkRegistration } from '../../scripts/probe-browser-network.mjs';

const repository = resolve(import.meta.dirname, '../..');
const executable = String.raw`import fs from 'node:fs';
import cp from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
const root=dirname(fileURLToPath(import.meta.url));
const file=join(root,'daemon.json');
const state=JSON.parse(fs.readFileSync(file,'utf8'));
const role=basename(process.argv[1]);
const args=process.argv.slice(2);
const proxies=['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','ALL_PROXY','http_proxy','https_proxy','no_proxy','all_proxy'];
const proxyInherited=proxies.some(name=>process.env[name]!==undefined);
state.events.push({role,args,proxyInherited,keyPresent:process.env.DMXAPI_KEY!==undefined});
const save=value=>fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
save(state);
if(role==='git'){
 if(args[0]==='rev-parse')process.stdout.write(state.sha+'\n');
 if(proxyInherited||process.env.DMXAPI_KEY!==undefined)process.exitCode=19;
} else if(role==='systemctl')process.stdout.write('LoadState=not-found\n');
else if(role==='pnpm'){
 if(proxyInherited)process.exitCode=19;
 else if(args[0]==='test:model'){
  if(process.env.DMXAPI_KEY!==state.canary)process.exitCode=19;
  else {
   const original=cp.spawnSync;
   cp.spawnSync=(binary,args,options)=>original(binary==='docker'?join(root,'bin/docker'):binary,args,options);
   os.platform=()=> 'linux';
   syncBuiltinESMExports();
   const {createDockerCommands}=await import(pathToFileURL(join(state.repository,'platform/test/docker-command.ts')));
   const result=createDockerCommands(state.repository,join(root,'client-config'),false).command(['info'],5000);
   if(result.status!==0||result.stdout!=='proxy-permitted')process.exitCode=20;
   else {
    const current=JSON.parse(fs.readFileSync(file,'utf8'));current.driverPassed=true;save(current);
    process.stdout.write('model-client-boundary-ok');
   }
  }
 } else if(process.env.DMXAPI_KEY!==undefined)process.exitCode=19;
} else if(role==='docker'){
 if(args[0]==='image'&&args[1]==='inspect'&&!state.imagePresent){
  process.stderr.write('Error: No such image: '+args.at(-1)+'\n');process.exitCode=1;
 } else {
  const result=Promise.withResolvers();
  const agent=new http.Agent({proxyEnv:process.env});
  const request=http.get(state.destination,{agent},response=>{
   let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>result.resolve(body));
  });
  request.on('error',()=>result.resolve('transport-rejected'));
  request.setTimeout(1000,()=>request.destroy());
  const body=await result.promise;agent.destroy();
  if(body!=='proxy-permitted')process.exitCode=21;
  else if(args[0]==='info')process.stdout.write(body);
  else if(['container','network'].includes(args[0])&&args[1]==='inspect'){
   process.stderr.write('Error: No such '+args[0]+': '+args.at(-1)+'\n');process.exitCode=1;
  }
  else if(args[0]==='image'&&args[1]==='inspect'){
   if(args.includes('{{.Id}}'))process.stdout.write(state.imageId);
   else if(args.some(value=>value.includes('.Config.Labels')))process.stdout.write(state.invocation);
   else process.stdout.write('{}');
  } else if(args[0]==='image'&&args[1]==='rm'){
   if(args.at(-1)!==state.imageId)process.exitCode=22;
   else {state.imagePresent=false;state.removed.push(state.imageId);save(state);}
  } else process.exitCode=23;
 }
} else process.exitCode=24;
`;

export async function runWorkerProxyScenario(
  mode: 'execute' | 'finalize-locked' | 'browser-rescue',
) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-worker-proxy-'));
  const invocation = randomUUID();
  const canary = randomUUID();
  const server = new Worker(
    `const {parentPort}=require('node:worker_threads');const http=require('node:http');
const direct=http.createServer((req,res)=>res.end('direct-rejected'));
const proxy=http.createServer((req,res)=>res.end('proxy-permitted'));
direct.listen(0,'127.0.0.1',()=>proxy.listen(0,'127.0.0.1',()=>parentPort.postMessage({direct:direct.address().port,proxy:proxy.address().port})));`,
    { eval: true },
  );
  try {
    const [ports] = (await once(server, 'message')) as [{ direct: number; proxy: number }];
    const root = join(home, '.local/share/dsh-team/ci', invocation);
    const config = join(home, '.config/dsh-team');
    const bin = join(home, 'bin');
    await Promise.all([
      mkdir(root, { recursive: true, mode: 0o700 }),
      mkdir(config, { recursive: true, mode: 0o700 }),
      mkdir(bin),
    ]);
    await writeFile(
      join(config, 'docker-proxy.json'),
      JSON.stringify({
        HTTP_PROXY: `http://127.0.0.1:${String(ports.proxy)}`,
        NO_PROXY: '',
      }),
      { mode: 0o600 },
    );
    await writeFile(join(config, 'env'), `DMXAPI_KEY=${canary}\n`, { mode: 0o600 });
    const imageId = `sha256:${'a'.repeat(64)}`;
    const sha = 'b'.repeat(40);
    await writeFile(
      join(home, 'daemon.json'),
      JSON.stringify({
        invocation,
        imageId,
        sha,
        canary,
        repository,
        destination: `http://127.0.0.1:${String(ports.direct)}/token`,
        imagePresent: true,
        removed: [],
        events: [],
        driverPassed: false,
      }),
      { mode: 0o600 },
    );
    const tool = join(home, 'tool.mjs');
    await writeFile(tool, `#!${process.execPath}\n${executable}`, { mode: 0o700 });
    for (const name of ['git', 'pnpm', 'docker', 'systemctl']) await symlink(tool, join(bin, name));
    const preload = join(home, 'host.mjs');
    await writeFile(
      preload,
      `import cp from 'node:child_process';import os from 'node:os';import {join} from 'node:path';import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'linux'});os.platform=()=> 'linux';
const original=cp.spawnSync;
cp.spawnSync=(binary,args,options)=>{
 if(['git','pnpm','docker','systemctl'].includes(binary))return original(join(${JSON.stringify(bin)},binary),args,options);
 if(binary===process.execPath&&args[0]==='-e')return original(binary,['--import',${JSON.stringify(preload)},...args],options);
 return original(binary,args,options);
};syncBuiltinESMExports();`,
    );
    if (mode === 'execute') {
      await writeFile(
        join(root, 'approval.json'),
        JSON.stringify({
          repository: 'DankerMu/dsh-team',
          repositoryId: '1',
          ownerId: '2',
          actorId: '2',
          sha,
          workflowSha: sha,
          ref: 'refs/heads/codex/proxy-fixture',
          workflowRef: 'fixture',
          audience: 'fixture',
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        }),
        { mode: 0o600 },
      );
      await writeFile(join(root, 'admitted.json'), '{}', { mode: 0o600 });
    } else {
      const directory = join(root, 'tmp/dsh-browser-command-owned');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, 'image.json'),
        JSON.stringify({
          invocation,
          tag: `dsh-team-browser-runtime-${invocation}`,
          imageId,
          state: 'build-failed',
        }),
        { mode: 0o600 },
      );
      if (mode === 'browser-rescue') {
        const nonce = randomUUID();
        const pointer = join(directory, `${nonce}.launch.json`);
        await writeFile(
          pointer,
          JSON.stringify({
            version: 1,
            nonce,
            kind: 'docker-isolated-network',
            state: 'stopped',
            runId: invocation,
            imageId,
            containerName: `dsh-team-browser-${nonce}`,
            containerId: null,
            ...networkRegistration(nonce),
            acquisition: { state: 'not-started' },
            receiptFile: pointer,
          }),
          { mode: 0o600 },
        );
      }
    }
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        join(repository, 'platform/test/ci-vps-worker.ts'),
        mode === 'execute' ? mode : 'finalize-locked',
        invocation,
      ],
      { env: { HOME: home, PATH: bin }, encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384 },
    );
    if (result.error || result.signal !== null)
      throw new Error('Owned worker proxy fixture did not settle');
    const daemon: unknown = JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8'));
    if (typeof daemon !== 'object' || daemon === null)
      throw new Error('Owned daemon state missing');
    // The object envelope is checked; projected journal fields remain unknown for assertions.
    const state = daemon as Record<string, unknown>;
    const receipt: unknown = JSON.parse(
      await readFile(join(root, mode === 'execute' ? 'execution.json' : 'final.json'), 'utf8'),
    );
    const log = mode === 'execute' ? await readFile(join(root, 'execution.log'), 'utf8') : '';
    return {
      exit: result.status,
      receipt,
      output: result.stdout + result.stderr + log,
      canary,
      imagePresent: state.imagePresent,
      removed: state.removed,
      driverPassed: state.driverPassed,
      events: state.events,
    };
  } finally {
    await server.terminate();
    await rm(home, { recursive: true, force: true });
  }
}
