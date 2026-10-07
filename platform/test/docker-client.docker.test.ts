import { randomUUID } from 'node:crypto';
import { arch, platform } from 'node:os';
import { beforeAll, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createDockerClient } from '../src/orchestrator/index.ts';

beforeAll(() => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
});
const client = createDockerClient(
  loadConfig({ PLATFORM_PUBLIC_URL: 'http://127.0.0.1' }).dockerSocketPath,
);

it('reads the actual Docker daemon version as JSON through the Unix client', async () => {
  const document = await client.json('GET', '/version');

  if (typeof document !== 'object' || document === null || !('Version' in document)) {
    throw new Error('Docker version response must contain Version');
  }
  expect(document.Version).toMatch(/^\d+\.\d+\.\d+/);
});

it('reports Docker HTTP404 for a unique nonexistent container without creating resources', async () => {
  await expect(
    client.json('GET', `/containers/dsh-team-test-absent-${randomUUID()}/json`),
  ).rejects.toMatchObject({ statusCode: 404 });
});

it('names a unique absent Unix socket in the connection error', async () => {
  const socket = `/var/run/dsh-team-test-${randomUUID()}.sock`;

  await expect(createDockerClient(socket).json('GET', '/version')).rejects.toThrow(
    `Docker socket ${socket}: ENOENT`,
  );
});
