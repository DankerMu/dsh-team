import type * as ChildProcessModule from 'node:child_process';
import type { SpawnOptions, SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { createDockerCommands } from './docker-command.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  return {
    ...original,
    // Only the external binary is substituted; environment, HTTP, streams and closure are real.
    spawn(_binary: string, args: readonly string[], options: SpawnOptions) {
      return original.spawn(process.execPath, ['-e', ...args], options);
    },
    spawnSync(
      _binary: string,
      args: readonly string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) {
      return original.spawnSync(process.execPath, ['-e', ...args], options);
    },
  };
});

afterEach(() => vi.unstubAllEnvs());

it('routes Docker child HTTP and HTTPS through explicit proxies and honors bypass without admitting ambient credentials', async () => {
  // An independent thread keeps real servers responsive during synchronous child execution.
  const server = new Worker(
    `const {parentPort}=require('node:worker_threads');
     const http=require('node:http');
     const direct=http.createServer((req,res)=>res.end('direct-resource'));
     const proxy=http.createServer((req,res)=>{
       if(req.url.startsWith('http://127.0.0.1:'))res.end('proxied-resource');
       else {res.statusCode=400;res.end('unexpected-target');}
     });
     const tunnels=[];
     proxy.on('connect',(req,socket)=>{
       tunnels.push(req.url);
       socket.end('HTTP/1.1 403 Forbidden\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n');
     });
     parentPort.on('message',()=>parentPort.postMessage(tunnels.splice(0)));
     direct.listen(0,'127.0.0.1',()=>proxy.listen(0,'127.0.0.1',()=>
       parentPort.postMessage({direct:direct.address().port,proxy:proxy.address().port})));`,
    { eval: true },
  );
  try {
    const [ports] = (await once(server, 'message')) as [{ direct: number; proxy: number }];
    vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${String(ports.proxy)}`);
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${String(ports.proxy)}`);
    vi.stubEnv('NO_PROXY', '');
    for (const name of [
      'GH_TOKEN',
      'SSH_AUTH_SOCK',
      'DMXAPI_KEY',
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'http_proxy',
      'https_proxy',
      'no_proxy',
    ])
      vi.stubEnv(name, 'unrelated-custody-canary');
    vi.stubEnv('DOCKER_CONFIG', '/unrelated-user-configuration');
    const commands = createDockerCommands(process.cwd(), '/owned-private-docker-config', false);
    const source = `const http=require('node:http');
      const denied=['GH_TOKEN','SSH_AUTH_SOCK','DMXAPI_KEY','DOCKER_HOST','DOCKER_CONTEXT','http_proxy','https_proxy','no_proxy'];
      if(denied.some(key=>process.env[key]!==undefined)||
         process.env.DOCKER_CONFIG!=='/owned-private-docker-config'||
         process.env.PATH!=='/usr/local/bin:/usr/bin:/bin')process.exit(19);
      const agent=new http.Agent({proxyEnv:process.env});
      http.get('http://127.0.0.1:${String(ports.direct)}/resource',{agent},res=>{
        res.pipe(process.stdout);res.on('end',()=>agent.destroy());
      }).on('error',()=>process.exit(20));`;
    const secureSource = `const https=require('node:https');
      const agent=new https.Agent({proxyEnv:process.env});
      https.get('https://127.0.0.1:${String(ports.direct)}/resource',{agent},res=>{
        res.resume();res.on('end',()=>{agent.destroy();process.exitCode=21;});
      }).on('error',()=>{agent.destroy();process.exitCode=20;});`;

    for (const command of [commands.command, commands.commandAsync]) {
      const proxied = await command([source], 5_000);
      expect(proxied).toMatchObject({ status: 0, stdout: 'proxied-resource', stderr: '' });
      const secure = await command([secureSource], 5_000);
      const observedTunnel = once(server, 'message');
      server.postMessage('observed-tunnels');
      expect(await observedTunnel).toEqual([[`127.0.0.1:${String(ports.direct)}`]]);
      expect(secure).toMatchObject({ status: 20, stdout: '', stderr: '' });
      vi.stubEnv('NO_PROXY', '127.0.0.1');
      const bypassed = await command([source], 5_000);
      expect(bypassed).toMatchObject({ status: 0, stdout: 'direct-resource', stderr: '' });
      vi.stubEnv('NO_PROXY', '');
      vi.stubEnv('HTTP_PROXY', undefined);
      const absent = await command([source], 5_000);
      expect(absent).toMatchObject({ status: 0, stdout: 'direct-resource', stderr: '' });
      vi.stubEnv('HTTP_PROXY', '');
      const empty = await command([source], 5_000);
      expect(empty).toMatchObject({ status: 0, stdout: 'direct-resource', stderr: '' });
      vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${String(ports.proxy)}`);
    }
  } finally {
    await server.terminate();
  }
});
