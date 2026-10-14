import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { expect } from 'vitest';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { output, OWNER_LABEL } from './docker-cleanup.ts';
import { activityUpgradeRequest } from './gateway-activity-fixture.ts';
import { observeHttp, reader, unusedPort } from './gateway-http-fixture.ts';
import type { Deployment } from './deployment-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

function tlsRequest(certificate: Buffer): Deployment['request'] {
  return (url, init) =>
    new Promise((resolve, reject) => {
      if (init?.body !== undefined && typeof init.body !== 'string')
        throw new Error('Expected text request body');
      const outgoing = request(
        url,
        {
          ca: certificate,
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init?.headers)),
          signal: init?.signal ?? AbortSignal.timeout(10_000),
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('error', reject);
          incoming.on('end', () => {
            const headers = new Headers();
            for (let index = 0; index < incoming.rawHeaders.length; index += 2)
              headers.append(
                incoming.rawHeaders[index] ?? '',
                incoming.rawHeaders[index + 1] ?? '',
              );
            resolve(
              new Response(new Uint8Array(Buffer.concat(chunks)), {
                status: incoming.statusCode ?? 502,
                headers,
              }),
            );
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end(init?.body);
    });
}

export async function prepareTlsDeployment(lifecycle: UserImageLifecycle, deployment: Deployment) {
  const directory = join(deployment.directory, 'tls');
  await mkdir(directory, { mode: 0o700 });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
    ],
    { stdio: 'ignore', timeout: 15_000, env: { PATH: '/usr/local/bin:/usr/bin:/bin' } },
  );
  const certificate = await readFile(join(directory, 'cert.pem'));
  const name = `dsh-team-test-${lifecycle.runId}-tls`;
  const ownership = { [OWNER_LABEL]: lifecycle.runId };
  await lifecycle.registerResourceAsync('container', name, ownership);
  const port = await unusedPort();
  const override = join(deployment.directory, 'tls-compose.json');
  const proxy = {
    image: lifecycle.imageId,
    container_name: name,
    user: '1000:1000',
    labels: ownership,
    command: ['node', '/proxy.ts', '/tls', String(deployment.port)],
    ports: [`127.0.0.1:${String(port)}:8443`],
    volumes: [
      {
        type: 'bind',
        source: directory,
        target: '/tls',
        read_only: true,
        bind: { create_host_path: false },
      },
      {
        type: 'bind',
        source: join(lifecycle.repositoryRoot, 'platform/test/deployment-tls-proxy.ts'),
        target: '/proxy.ts',
        read_only: true,
        bind: { create_host_path: false },
      },
    ],
  };
  await writeFile(override, JSON.stringify({ services: { proxy } }), { mode: 0o600 });
  deployment.compose.push('--file', override);
  const start = [
    ...deployment.compose,
    'up',
    '-d',
    '--no-deps',
    '--no-build',
    '--pull',
    'never',
    'proxy',
  ];
  output(await lifecycle.commandAsync(start, 30_000), start);
  const inspected = await inspectAsync(lifecycle, name);
  const networks = Object.values(record(record(inspected.NetworkSettings).Networks));
  expect(networks).toHaveLength(1);
  const address = record(networks[0]).IPAddress;
  if (typeof address !== 'string' || address === '') throw new Error('Missing TLS proxy address');
  deployment.base = `https://127.0.0.1:${String(port)}`;
  deployment.port = port;
  deployment.request = tlsRequest(certificate);
  await writeFile(
    override,
    JSON.stringify({
      services: {
        proxy,
        platform: {
          environment: {
            PLATFORM_PUBLIC_URL: deployment.base,
            PLATFORM_COOKIE_SECURE: 'true',
            PLATFORM_TRUSTED_PROXIES: address,
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  return { certificate, name, address };
}

export async function verifyTlsCarrier(
  deployment: Deployment,
  certificate: Buffer,
  cookie: string,
) {
  const socket = connect({ host: '127.0.0.1', port: deployment.port, ca: certificate });
  const closed = once(socket, 'close');
  const read = reader(socket);
  try {
    await observeHttp(once(socket, 'secureConnect'));
    expect(socket.authorized).toBe(true);
    socket.write(
      activityUpgradeRequest(deployment.port, cookie, deployment.base).replace(
        '/activity-ws',
        '/api/remote.mux',
      ),
    );
    expect((await observeHttp(read('\r\n\r\n'))).toString()).toMatch(/^HTTP\/1\.1 101 /);
    socket.write(Buffer.from([0x89, 0x81, 1, 2, 3, 4, 0x79]));
    const pong = await observeHttp(
      (async () => {
        for (;;) {
          const header = await read(2);
          const payload = await read((header[1] ?? 0) & 127);
          if ((header[0] ?? 0) === 0x8a) return payload;
        }
      })(),
    );
    expect(pong).toEqual(Buffer.from('x'));
    expect(socket.destroyed).toBe(false);
  } finally {
    socket.destroy();
    await closed;
  }
}
