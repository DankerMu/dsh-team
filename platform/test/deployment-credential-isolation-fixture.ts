import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';
import { httpRequest } from '../../scripts/probe-dsh-api-cdp.mjs';
import { extractLaunchToken } from '../src/orchestrator/index.ts';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';
import type { Deployment } from './deployment-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

interface Employee {
  id: string;
  cookie: string;
  registrationCookie: string;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string'))
    throw new Error('Missing private credential inventory');
  return value;
}

function valueOf(cookie: string) {
  const offset = cookie.indexOf('=');
  if (offset < 1 || offset === cookie.length - 1) throw new Error('Missing private cookie value');
  return cookie.slice(offset + 1);
}

export async function verifyCredentialIsolation(
  lifecycle: UserImageLifecycle,
  deployment: Deployment,
  a: Employee,
  b: Employee,
  admin: { cookie: string },
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
  const run = async (args: string[], timeout = 15_000) => {
    const result = await lifecycle.commandAsync(args, timeout);
    if (result.status !== 0 || result.error !== undefined)
      throw new Error('Private credential observation failed');
    try {
      return record(JSON.parse(result.stdout));
    } catch {
      throw new Error('Invalid private credential observation');
    }
  };
  const inventory = await run([
    'exec',
    'dsh-team-platform',
    'node',
    '--input-type=module',
    '-e',
    `
import {join} from 'node:path';
import {loadConfig} from './platform/dist/config.js';
import {openDatabase} from './platform/dist/db/index.js';
const db=openDatabase(join(loadConfig(process.env).dataDir,'platform.db'));
try { console.log(JSON.stringify({
 cookies:db.prepare("SELECT user_id,dsh_cookie FROM instances WHERE status='running'").all(),
 hashes:db.prepare('SELECT password_hash FROM users').all().map(row=>row.password_hash),
 sessions:db.prepare('SELECT token_hash FROM platform_sessions').all().map(row=>row.token_hash)
})); } finally { db.close(); }`,
  ]);
  if (!Array.isArray(inventory.cookies)) throw new Error('Missing native credential inventory');
  const cookies = inventory.cookies.map((row: unknown) => record(row));
  const credentials = async (user: Employee) => {
    const name = `dsh-team-u-${user.id}`;
    const container = await inspectAsync(lifecycle, name);
    expect(record(container.HostConfig).Privileged).toBe(false);
    expect(record(container.Config).User).toBe('1001');
    const endpoint = record(
      record(record(container.NetworkSettings).Networks)[`dsh-team-net-${user.id}`],
    );
    const cookie = cookies.find((row) => row.user_id === user.id)?.dsh_cookie;
    if (typeof endpoint.IPAddress !== 'string' || typeof cookie !== 'string')
      throw new Error('Missing native credential binding');
    const logs = await lifecycle.commandAsync(['logs', name], 15_000);
    if (logs.status !== 0 || logs.error !== undefined)
      throw new Error('Private launch observation failed');
    const token = extractLaunchToken(logs.stdout, endpoint.IPAddress);
    if (token === undefined) throw new Error('Missing actual launch token');
    return { name, host: endpoint.IPAddress, cookie, token, container };
  };
  const first = await credentials(a);
  const second = await credentials(b);
  expect(first.cookie === second.cookie).toBe(false);
  expect(first.token === second.token).toBe(false);
  const sessions = [
    admin.cookie,
    a.cookie,
    a.registrationCookie,
    b.cookie,
    b.registrationCookie,
  ].map(valueOf);
  const sessionHashes = strings(inventory.sessions);
  expect(sessionHashes.length).toBe(sessions.length);
  expect(new Set(sessions).size).toBe(sessions.length);
  expect(
    sessions.every((value) =>
      sessionHashes.includes(createHash('sha256').update(value).digest('hex')),
    ),
  ).toBe(true);
  const hashes = strings(inventory.hashes);
  expect(hashes.length).toBe(3);
  const needles = [...sessions, ...sessionHashes, ...hashes, valueOf(first.cookie), first.token];
  expect(needles.every((value) => value.length >= 32)).toBe(true);
  if (!Array.isArray(second.container.Mounts)) throw new Error('Missing employee mounts');
  for (const item of second.container.Mounts) {
    const source = record(item).Source;
    if (typeof source !== 'string') throw new Error('Missing mount source');
    expect(
      source === deployment.dataDir ||
        source.startsWith(`${deployment.dataDir}/`) ||
        deployment.dataDir.startsWith(`${source}/`),
    ).toBe(false);
  }
  const marker = `scan-positive-${lifecycle.runId}`;
  await gateway.exec(
    second.name,
    `import {writeFileSync} from 'node:fs';
writeFileSync('/data/work/credential-scan-positive.txt',${JSON.stringify(marker)});`,
  );
  const scan = await run(
    [
      'exec',
      '--user',
      '1001',
      '--env',
      `DSH_TEAM_SCAN_POSITIVE=${marker}`,
      second.name,
      'python3',
      '-c',
      await readFile(new URL('./deployment-credential-scan.py', import.meta.url), 'utf8'),
      JSON.stringify({ needles, marker, database: `${deployment.dataDir}/platform.db` }),
    ],
    75_000,
  );
  expect(scan).toMatchObject({
    uid: 1001,
    fileHits: false,
    envHits: false,
    database: false,
    fileMarker: true,
    envMarker: true,
    home: true,
    work: true,
  });
  // These metadata counts disclose inaccessible/vanished paths, never their names or bytes.
  for (const field of ['files', 'bytes', 'denied', 'vanished'])
    expect(Number.isSafeInteger(scan[field]) && Number(scan[field]) >= 0).toBe(true);
  process.stdout.write(
    JSON.stringify({
      credentialScan: {
        files: scan.files,
        bytes: scan.bytes,
        denied: scan.denied,
        vanished: scan.vanished,
      },
    }) + '\n',
  );
  const authority = new URL(deployment.base).host;
  const native = async (host: string, path = '/', cookie = '') => {
    const response = record(
      await httpRequest({ host, port: 3080, path, headers: { host: authority, cookie } }),
    );
    return {
      status: response.status,
      cookies: strings(record(response.headers)['set-cookie'] ?? []),
    };
  };
  for (const target of [first, second]) {
    expect((await native(target.host, '/', target.cookie)).status).toBe(200);
    const exchange = await native(target.host, `/?token=${encodeURIComponent(target.token)}`);
    expect(exchange.status).toBe(303);
    expect(exchange.cookies.length).toBe(1);
    const cookie = exchange.cookies[0]?.split(';', 1)[0];
    if (cookie === undefined) throw new Error('Missing exchanged native cookie');
    expect((await native(target.host, '/', cookie)).status).toBe(200);
  }
  for (const request of [
    { path: '/', cookie: first.cookie },
    { path: `/?token=${encodeURIComponent(first.token)}`, cookie: '' },
  ]) {
    const rejected = await native(second.host, request.path, request.cookie);
    expect(rejected.status).toBe(401);
    expect(rejected.cookies.length).toBe(0);
  }
  expect((await native(second.host, '/', second.cookie)).status).toBe(200);
}
