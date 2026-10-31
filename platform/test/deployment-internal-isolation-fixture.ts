import { expect } from 'vitest';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';
import { listen, probe } from './network-probe-fixture.ts';
import type { Deployment } from './deployment-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

interface Employee {
  id: string;
  cookie: string;
}

export async function verifyInternalIsolation(
  lifecycle: UserImageLifecycle,
  deployment: Deployment,
  a: Employee,
  b: Employee,
  admin: { cookie: string },
  execute?: (args: readonly string[]) => Promise<string>,
) {
  const gateway = instanceGatewayFixture({
    lifecycle,
    base: deployment.base,
    origin: deployment.base,
  });
  for (const user of [a, b]) {
    await gateway.state(user.cookie, true);
    await gateway.ready(user.cookie);
  }
  const first = `dsh-team-u-${a.id}`;
  const second = `dsh-team-u-${b.id}`;
  // Test seam: identical B probe bytes run through Docker or the real Agent's native bash tool.
  const executeNodeProbe = (script: string) =>
    execute ? execute(['node', '--input-type=module', '-e', script]) : gateway.exec(second, script);
  const container = await inspectAsync(lifecycle, first);
  const endpoint = record(
    record(record(container.NetworkSettings).Networks)[`dsh-team-net-${a.id}`],
  );
  if (typeof endpoint.IPAddress !== 'string') throw new Error('Missing A network address');
  const hosts = [endpoint.IPAddress, `u-${a.id}`];
  const platform = await inspectAsync(lifecycle, 'dsh-team-platform');
  const platformEndpoint = record(
    record(record(platform.NetworkSettings).Networks)[`dsh-team-net-${b.id}`],
  );
  if (typeof platformEndpoint.IPAddress !== 'string') throw new Error('Missing platform endpoint');
  const platformBase = `http://${platformEndpoint.IPAddress}:${String(deployment.port)}`;
  const filename = `internal-a-${lifecycle.runId}.txt`;
  const paths = ['/data/home', '/data/work'].map((path) => `${path}/${filename}`);
  if (!Array.isArray(container.Mounts)) throw new Error('Missing A mounts');
  const sources = container.Mounts.map((mount: unknown) => record(mount))
    .filter((mount) => mount.Destination === '/data/home' || mount.Destination === '/data/work')
    .map((mount) => {
      expect(mount.Type).toBe('volume');
      if (typeof mount.Source !== 'string') throw new Error('Missing A volume source');
      return `${mount.Source}/${filename}`;
    });
  expect(sources).toHaveLength(2);
  const marker = `Owned A marker ${lifecycle.runId}`;
  const ownFiles = `import {readFileSync,writeFileSync} from 'node:fs';
const paths=${JSON.stringify(paths)}, marker=${JSON.stringify(marker)};
for(const path of paths) writeFileSync(path,marker);
console.log(JSON.stringify(paths.map(path=>readFileSync(path,'utf8')===marker)));`;
  expect(JSON.parse(await gateway.exec(first, ownFiles))).toEqual([true, true]);
  const python = async (id: string, script: string, addresses: string[] = []) => {
    const result = await lifecycle.commandAsync(
      ['exec', '--user', '1001', id, 'python3', '-c', script, ...addresses],
      15_000,
    );
    if (result.status !== 0 || result.error !== undefined) throw new Error('Network probe failed');
    const value: unknown = JSON.parse(result.stdout);
    return value;
  };
  expect(await python(first, listen)).toEqual({ uid: 1001, port: 3099 });
  const positive = () => python(first, probe, ['127.0.0.1', ...hosts]);
  // DSH 0.2.1 binds only the instance's +2 address, so the container's own loopback never reaches
  // 3080; 3099 proves loopback itself works.
  const reachable = [false, true, true, true, true, true];
  expect(await positive()).toEqual(reachable);
  const network: unknown = execute
    ? JSON.parse(await execute(['python3', '-c', probe, ...hosts]))
    : await python(second, probe, hosts);
  expect(await positive()).toEqual(reachable);
  const adminResponse = await deployment.request(`${deployment.base}/_platform/api/admin/users`, {
    headers: { cookie: admin.cookie },
  });
  expect(adminResponse.status).toBe(200);
  await adminResponse.arrayBuffer();

  // Emit only fixed outcome codes and digests; overlay bytes contain shared model credentials.
  const observed = record(
    JSON.parse(
      await executeNodeProbe(`
import {readFileSync,writeFileSync,statSync,unlinkSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {request} from 'node:http';
const outcome = action => {try {action();return 'allowed';} catch(error) {return error.code??'unknown';}};
const files=${JSON.stringify([...paths, ...sources])}.map(path=>outcome(()=>readFileSync(path)));
const own='/data/work/internal-b-${lifecycle.runId}.txt';
writeFileSync(own,'owned B');
const writable=readFileSync(own,'utf8')==='owned B';
const socket='/var/run/docker.sock';
const socketStat=outcome(()=>statSync(socket));
const socketRead=outcome(()=>readFileSync(socket));
const socketCall=await new Promise(resolve=>{
 const req=request({socketPath:socket,path:'/_ping',method:'GET'},res=>{
  res.resume();res.on('end',()=>resolve('allowed'));
 });
 const timer=setTimeout(()=>{req.destroy();resolve('timeout');},1000);
 req.once('close',()=>clearTimeout(timer));
 req.once('error',error=>resolve(error.code??'unknown'));
 req.end();
});
const base=${JSON.stringify(platformBase)};
const health=await fetch(base+'/healthz',{signal:AbortSignal.timeout(3000)});
const healthBody=await health.json();
const admin=await fetch(base+'/_platform/api/admin/users',{signal:AbortSignal.timeout(3000)});
await admin.arrayBuffer();
const overlay='/managed/patch.yml';
const digest=()=>createHash('sha256').update(readFileSync(overlay)).digest('hex');
const before=digest();
const overwrite=outcome(()=>writeFileSync(overlay,'forbidden replacement'));
const remove=outcome(()=>unlinkSync(overlay));
const replace=outcome(()=>renameSync(own,overlay));
console.log(JSON.stringify({uid:process.getuid(),files,writable,socketStat,socketRead,socketCall,
 health:health.status,healthy:healthBody.status==='ok',admin:admin.status,
 overwrite,remove,replace,unchanged:digest()===before}));
`),
    ),
  );
  expect(network, 'B cannot connect to A by IP or alias at either live port').toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(observed).toMatchObject({
    uid: 1001,
    writable: true,
    socketStat: 'ENOENT',
    socketRead: 'ENOENT',
    socketCall: 'ENOENT',
    health: 200,
    healthy: true,
    admin: 401,
    unchanged: true,
  });
  if (!Array.isArray(observed.files)) throw new Error('Missing file probe results');
  expect(observed.files).toHaveLength(4);
  for (const result of observed.files) expect(['ENOENT', 'EACCES']).toContain(result);
  expect(observed.overwrite).toBe('EROFS');
  // Cross-volume rename may fail before the mount-point check; overwrite separately proves EROFS.
  for (const result of [observed.remove, observed.replace])
    expect(['EROFS', 'EBUSY', 'EACCES', 'EPERM', 'EXDEV']).toContain(result);
  expect(
    JSON.parse(
      await gateway.exec(
        first,
        `import {readFileSync} from 'node:fs';
console.log(JSON.stringify(${JSON.stringify(paths)}.map(path=>readFileSync(path,'utf8')===${JSON.stringify(marker)})));`,
      ),
    ),
  ).toEqual([true, true]);
}
