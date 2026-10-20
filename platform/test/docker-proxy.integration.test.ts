import type * as OsModule from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import type * as DockerCommandModule from '../../scripts/docker-command.mjs';
import { createDockerCommands } from './docker-command.ts';

vi.mock('../../scripts/docker-command.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof DockerCommandModule>();
  return {
    ...original,
    // Selection precedes publication; environment, HTTP, streams and closure remain real.
    selectDockerExecution(args: readonly string[]) {
      return { file: process.execPath, args: ['-e', ...args] };
    },
  };
});

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof OsModule>()),
  // Only trusted-host qualification is substituted; private files and transport remain real.
  platform: () => 'linux',
}));

afterEach(() => vi.unstubAllEnvs());

it.each(['ambient', 'host-local'] as const)(
  'routes Docker child HTTP and HTTPS through %s proxies and honors bypass without admitting ambient credentials',
  async (sourceKind) => {
    const credential = sourceKind === 'host-local' ? `verification:${randomUUID()}` : undefined;
    const authorization =
      credential === undefined ? undefined : `Basic ${Buffer.from(credential).toString('base64')}`;
    // An independent thread keeps real servers responsive during synchronous child execution.
    const server = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');
     const http=require('node:http');
     const direct=http.createServer((req,res)=>res.end('direct-resource'));
     const proxy=http.createServer((req,res)=>{
       if(req.headers['proxy-authorization']!==workerData.authorization){res.statusCode=407;res.end('proxy-auth-rejected');return;}
       if(req.url.startsWith('http://127.0.0.1:'))res.end('proxied-resource');
       else {res.statusCode=400;res.end('unexpected-target');}
     });
     const tunnels=[];
     proxy.on('connect',(req,socket)=>{
       tunnels.push(req.headers['proxy-authorization']===workerData.authorization?req.url:'proxy-auth-rejected');
       socket.end('HTTP/1.1 403 Forbidden\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n');
     });
     parentPort.on('message',()=>parentPort.postMessage(tunnels.splice(0)));
     direct.listen(0,'127.0.0.1',()=>proxy.listen(0,'127.0.0.1',()=>
       parentPort.postMessage({direct:direct.address().port,proxy:proxy.address().port})));`,
      { eval: true, workerData: { authorization } },
    );
    let home: string | undefined;
    try {
      const [ports] = (await once(server, 'message')) as [{ direct: number; proxy: number }];
      const proxyUrl = `http://${credential === undefined ? '' : `${credential}@`}127.0.0.1:${String(ports.proxy)}`;
      home = await mkdtemp(join(tmpdir(), 'dsh-proxy-custody-'));
      const directory = join(home, '.config/dsh-team');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const settings: Record<string, string | undefined> = {};
      const configure = async (values: Record<string, string | undefined>) => {
        Object.assign(settings, values);
        if (sourceKind === 'host-local')
          await writeFile(join(directory, 'docker-proxy.json'), JSON.stringify(settings), {
            mode: 0o600,
          });
        else for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
      };
      if (sourceKind === 'host-local') {
        vi.stubEnv('HOME', home);
        vi.stubEnv('DSH_TEAM_CI_INVOCATION', randomUUID());
        // Both destinations are owned: hostile ambient values must not select the direct server.
        vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${String(ports.direct)}`);
        vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${String(ports.direct)}`);
        vi.stubEnv('NO_PROXY', '*');
      }
      await configure({
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        NO_PROXY: '',
      });
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
        await configure({ NO_PROXY: '127.0.0.1' });
        const bypassed = await command([source], 5_000);
        expect(bypassed).toMatchObject({ status: 0, stdout: 'direct-resource', stderr: '' });
        await configure({ NO_PROXY: '', HTTP_PROXY: undefined });
        const absent = await command([source], 5_000);
        expect(absent).toMatchObject({ status: 0, stdout: 'direct-resource', stderr: '' });
        await configure({ HTTP_PROXY: '' });
        const empty = await command([source], 5_000);
        expect(empty).toMatchObject({ status: 0, stdout: 'direct-resource', stderr: '' });
        if (sourceKind === 'host-local') {
          await rm(join(directory, 'docker-proxy.json'));
          const missing = await command([source], 5_000);
          expect(missing).toMatchObject({ status: 0, stdout: 'direct-resource', stderr: '' });
        }
        await configure({ HTTP_PROXY: proxyUrl });
      }
    } finally {
      await server.terminate();
      if (home !== undefined) await rm(home, { recursive: true, force: true });
    }
  },
);
