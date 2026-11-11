import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import {
  METADATA_REQUEST,
  PROBE_PLUGIN,
  PROBE_TARBALL,
  registryStandInScript,
  STAND_IN_REQUESTS,
  TARBALL_REQUEST,
} from './registry-stand-in.ts';

const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-team-stand-in-test-'));
  directories.push(directory);
  return directory;
}

function startStandIn(script: string): ChildProcess {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

/** The registry URL the stand-in writes to its readiness marker once it listens. */
async function awaitReady(child: ChildProcess, marker: string): Promise<string> {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const deadline = performance.now() + 20_000;
  while (!existsSync(marker)) {
    if (child.exitCode !== null)
      throw new Error(`stand-in exited ${String(child.exitCode)}: ${stderr}`);
    if (performance.now() >= deadline) throw new Error(`stand-in never became ready: ${stderr}`);
    await delay(25);
  }
  return readFileSync(marker, 'utf8');
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  return address.port;
}

/** Packed member names, listed by the host's own tar from the served bytes. */
function tarballMembers(bytes: Buffer, directory: string): string[] {
  const path = join(directory, 'served.tgz');
  writeFileSync(path, bytes);
  const listed = spawnSync('tar', ['-tzf', path], { encoding: 'utf8' });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout
    .split('\n')
    .filter((name) => name !== '' && !name.endsWith('/'))
    .sort();
}

it('names the probe plugin requests the #556 Docker case accepts', () => {
  expect(PROBE_TARBALL).toBe('/dsh-team-probe-plugin/-/dsh-team-probe-plugin-1.0.0.tgz');
  expect(METADATA_REQUEST).toBe('GET /dsh-team-probe-plugin');
  expect(TARBALL_REQUEST).toBe('GET /dsh-team-probe-plugin/-/dsh-team-probe-plugin-1.0.0.tgz');
  expect(STAND_IN_REQUESTS).toEqual([METADATA_REQUEST, TARBALL_REQUEST, 'GET /pnpm', 'GET /npm']);
});

it('serves the probe packument and tarball on an ephemeral port, 404s the rest and logs every request', async () => {
  const directory = scratch();
  const requestLog = join(directory, 'requests.log');
  const readyMarker = join(directory, 'ready');
  const child = startStandIn(registryStandInScript({ port: 0, requestLog, readyMarker }));
  const registry = await awaitReady(child, readyMarker);
  expect(registry).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*\/$/);
  expect(registry).not.toBe('http://127.0.0.1:0/');

  const packumentResponse = await fetch(`${registry}${PROBE_PLUGIN}`);
  expect(packumentResponse.status).toBe(200);
  expect(packumentResponse.headers.get('content-type')).toBe('application/json');
  const packument = (await packumentResponse.json()) as {
    name: string;
    'dist-tags': Record<string, string>;
    versions: Record<
      string,
      { name: string; version: string; dsh: unknown; dist: Record<string, string> }
    >;
  };
  expect(Object.keys(packument.versions)).toEqual(['1.0.0']);
  const version = packument.versions['1.0.0'];
  expect([packument.name, packument['dist-tags'], version?.name, version?.version]).toEqual([
    PROBE_PLUGIN,
    { latest: '1.0.0' },
    PROBE_PLUGIN,
    '1.0.0',
  ]);
  expect(version?.dsh).toEqual({ bundle: { patch: './cordis.patch.yml' } });
  expect(version?.dist.tarball).toBe(`${registry.slice(0, -1)}${PROBE_TARBALL}`);

  const tarballResponse = await fetch(String(version?.dist.tarball));
  expect(tarballResponse.status).toBe(200);
  const bytes = Buffer.from(await tarballResponse.arrayBuffer());
  expect(version?.dist).toEqual({
    tarball: `${registry.slice(0, -1)}${PROBE_TARBALL}`,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  });
  expect(tarballMembers(bytes, directory)).toEqual([
    'package/cordis.patch.yml',
    'package/package.json',
  ]);

  for (const path of ['pnpm', 'npm', 'other-package']) {
    const response = await fetch(`${registry}${path}`);
    expect([path, response.status, await response.text()]).toEqual([path, 404, '{}']);
  }
  expect(readFileSync(requestLog, 'utf8')).toBe(
    [METADATA_REQUEST, TARBALL_REQUEST, 'GET /pnpm', 'GET /npm', 'GET /other-package']
      .map((line) => `${line}\n`)
      .join(''),
  );
  // Standalone it keeps serving until killed: the listening server holds the process open.
  expect(child.exitCode).toBeNull();
}, 30_000);

it('listens on the fixed port it is given', async () => {
  const directory = scratch();
  const readyMarker = join(directory, 'ready');
  const port = await freePort();
  const child = startStandIn(registryStandInScript({ port, readyMarker }));
  expect(await awaitReady(child, readyMarker)).toBe(`http://127.0.0.1:${String(port)}/`);
  expect((await fetch(`http://127.0.0.1:${String(port)}/pnpm`)).status).toBe(404);
}, 30_000);

it('embeds in a probe script with in-memory requests only, nothing on stdout, and exits once closed', async () => {
  const trailer = `
const before = [...registryStandIn.requests];
await fetch(registryStandIn.registry + ${JSON.stringify(PROBE_PLUGIN)});
await fetch(registryStandIn.registry + 'npm');
const seen = [...registryStandIn.requests];
registryStandIn.requests.length = 0;
registryStandIn.server.close();
process.stdout.write(JSON.stringify({ before, seen, after: registryStandIn.requests }));
`;
  const child = startStandIn(registryStandInScript({ port: 0 }) + trailer);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const status = await new Promise((resolve) => child.once('exit', resolve));
  expect([status, stderr]).toEqual([0, '']);
  expect(JSON.parse(stdout)).toEqual({
    before: [],
    seen: [METADATA_REQUEST, 'GET /npm'],
    after: [],
  });
}, 30_000);
