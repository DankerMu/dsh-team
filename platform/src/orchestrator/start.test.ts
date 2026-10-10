import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseHandle } from '../db/index.ts';
import { writeSettings } from '../db/index.ts';
import type { Orchestrator } from './index.ts';
import {
  startupOwnerFixture,
  START_CONTAINER,
  START_HELPER,
  START_IMAGE,
  START_MODEL,
  START_USER,
} from '../../test/container-start-fixture.ts';

const roots: string[] = [];
const databases: DatabaseHandle[] = [];
let startUserContainer: Orchestrator['startUserContainer'];
let database: DatabaseHandle;
afterEach(async () => {
  for (const handle of databases.splice(0)) handle.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const context = await startupOwnerFixture();
  roots.push(context.root);
  databases.push(context.database);
  database = context.database;
  database
    .prepare('UPDATE users SET email = ? WHERE id = ?')
    .run('employee@example.test', START_USER);
  ({ startUserContainer } = context.owner);
  return {
    ...context,
    setAccount(value: { readonly email: string; readonly status: string } | undefined) {
      if (value === undefined) {
        context.database.prepare('DELETE FROM users WHERE id = ?').run(START_USER);
      } else {
        context.database
          .prepare('UPDATE users SET email = ?, status = ? WHERE id = ?')
          .run(value.email, value.status, START_USER);
      }
    },
  };
}

it.each([undefined, '', '   '])(
  'returns unconfigured for actual credential %j without Docker, overlays or audit writes',
  async (modelKey) => {
    const { root, daemon, input } = await fixture();
    const prepare = vi.spyOn(database, 'prepare');

    expect(await startUserContainer({ ...input, modelKey })).toEqual({ outcome: 'unconfigured' });

    expect(daemon.requests).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(1);
    await expect(stat(join(root, 'managed'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it.each([undefined, { email: 'employee@example.test', status: 'disabled' }])(
  'rejects unavailable accounts before side effects',
  async (account) => {
    const context = await fixture();
    const { daemon, input } = context;
    context.setAccount(account);
    await expect(startUserContainer(input)).rejects.toThrow(/account validation/);
    expect(daemon.requests).toEqual([]);
  },
);

it('rejects a malformed identity before querying an account or Docker', async () => {
  const { daemon, input } = await fixture();
  const prepare = vi.spyOn(database, 'prepare');
  await expect(startUserContainer({ ...input, userId: '../foreign' })).rejects.toThrow(
    /account validation/,
  );
  expect(prepare).not.toHaveBeenCalled();
  expect(daemon.requests).toEqual([]);
});

it('starts the captured image with one readonly generated overlay, owned mounts and exact loopback publication', async () => {
  const { daemon, input } = await fixture();
  const result = await startUserContainer(input);

  expect(result).toEqual({
    outcome: 'starting',
    containerId: START_CONTAINER,
    upstreamHost: '127.0.0.1',
    upstreamPort: 49173,
  });
  const final = daemon.containers.get(START_CONTAINER);
  expect(final?.Config).toMatchObject({
    Image: START_IMAGE,
    Hostname: 'u-abcdefghijkl',
    User: '1001',
    WorkingDir: '/data/work',
    Env: ['DSH_HOME=/data/home', 'DSH_TELEMETRY_DISABLED=1', 'DMXAPI_KEY=fixture-private-key'],
    Cmd: [
      'dsh',
      '--profile',
      'web',
      '--patch',
      '/managed/patch.yml',
      '--no-open',
      '--trusted-host',
      'team.example:8443',
    ],
    Labels: { 'dsh-team.user': 'abcdefghijkl' },
    HostConfig: {
      Privileged: false,
      CapAdd: [],
      SecurityOpt: ['seccomp={"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}'],
      PortBindings: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
      Mounts: [
        { Type: 'volume', Source: 'dsh-team-home-abcdefghijkl', Target: '/data/home' },
        { Type: 'volume', Source: 'dsh-team-work-abcdefghijkl', Target: '/data/work' },
        {
          Type: 'bind',
          Source: join(input.config.managedConfigDir, 'abcdefghijkl.patch.yml'),
          Target: '/managed/patch.yml',
          ReadOnly: true,
        },
      ],
    },
  });
  const helpers = daemon.requests.filter((request) =>
    request.path.startsWith('/containers/create?name=dsh-team-compose-'),
  );
  expect(helpers[0]?.body).toMatchObject({
    Image: START_IMAGE,
    User: '1001',
    Env: ['DSH_HOME=/data/home', 'DSH_TELEMETRY_DISABLED=1'],
    HostConfig: {
      NetworkMode: 'none',
      Privileged: false,
      Mounts: [{ Type: 'volume', Source: 'dsh-team-home-abcdefghijkl', Target: '/data/home' }],
    },
  });
  expect(JSON.stringify(helpers)).not.toContain('fixture-private-key');
  expect(daemon.containers.has(START_HELPER)).toBe(false);
  const overlay = join(input.config.managedConfigDir, 'abcdefghijkl.patch.yml');
  expect((await stat(overlay)).mode & 0o777).toBe(0o444);
  const text = await readFile(overlay, 'utf8');
  const rows: unknown = JSON.parse(text);
  expect(rows).toContainEqual({
    id: 'agent-default-model',
    config: { provider: 'intranet', model: 'office-model' },
  });
  expect(rows).toContainEqual({
    id: 'assistant',
    name: '@deepseek-ai/dsh-agent-preset',
    config: { id: 'assistant', plugins: [{ name: '@deepseek-ai/dsh-tool-bash' }] },
  });
  expect(rows).toContainEqual({ id: 'locale', name: '@dsh-team/zh-locale' });
  expect(text).not.toContain('fixture-private-key');
});

it.each([
  ['approval', 'approval'],
  ['auto', 'auto-review'],
  ['yolo', 'danger-full-access'],
] as const)(
  'uses canonical administrator %s rather than a caller permission object',
  async (tier, preset) => {
    const { input } = await fixture();
    writeSettings(database, { defaultPermissionTier: tier });
    const attemptedBypass = { ...input, permission: { defaultPreset: 'employee-override' } };

    await startUserContainer(attemptedBypass);
    const rows: unknown = JSON.parse(
      await readFile(join(input.config.managedConfigDir, 'abcdefghijkl.patch.yml'), 'utf8'),
    );

    expect(rows).toContainEqual({
      id: 'permission',
      disabled: false,
      config: {
        presets: {
          approval: { sandbox: 'danger-full-access', approval: 'ask', name: '人工批准' },
          'auto-review': { sandbox: 'danger-full-access', approval: 'ask', name: 'Auto' },
          'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'Yolo' },
        },
        defaultPreset: preset,
      },
    });
  },
);

it.each(['owned', 'foreign'])(
  'refuses an existing %s canonical container without adopting it',
  async (owner) => {
    const { daemon, input } = await fixture();
    daemon.overrides.set('GET /containers/dsh-team-u-abcdefghijkl/json', {
      status: 200,
      document: { Config: { Labels: { 'dsh-team.user': owner } } },
    });
    await expect(startUserContainer(input)).rejects.toThrow(/container conflict check/);
    expect(daemon.requests.map((request) => request.method)).toEqual(['GET']);
  },
);

it.each(['not-json', 'null', '{}', '{"defaultAction":"unconfined","syscalls":[]}'])(
  'rejects malformed seccomp before creating resources: %s',
  async (policy) => {
    const { daemon, input } = await fixture();
    await writeFile(input.config.seccompProfilePath, policy);
    await expect(startUserContainer(input)).rejects.toThrow(/seccomp policy/);
    expect(daemon.requests.map((request) => request.method)).toEqual(['GET']);
  },
);

it('returns unconfigured before Docker, overlay or audit writes when model settings are incomplete', async () => {
  const { daemon, input } = await fixture();
  const prepare = vi.spyOn(database, 'prepare');
  expect(
    await startUserContainer({ ...input, modelSettings: { ...START_MODEL, models: [] } }),
  ).toEqual({ outcome: 'unconfigured' });
  expect(daemon.requests).toEqual([]);
  expect(prepare).toHaveBeenCalledTimes(1);
  await expect(stat(input.config.managedConfigDir)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['invalid-json', 'x'.repeat(1024 * 1024 + 1)])(
  'cleans the helper and preserves volumes after invalid or excessive composition output',
  async (output) => {
    const { daemon, input } = await fixture();
    daemon.setComposition(output);
    const error: unknown = await startUserContainer(input).catch((failure: unknown) => failure);
    expect(String(error)).toMatch(/managed composition/);
    expect(daemon.containers.size).toBe(0);
    expect(
      daemon.requests
        .filter((request) => request.method === 'DELETE')
        .map((request) => request.path),
    ).toEqual([`/containers/${START_HELPER}?force=true`]);
  },
);

it('preserves primary and cleanup failure categories without deleting a helper whose ownership changed', async () => {
  const { daemon, input } = await fixture();
  daemon.setComposition('fixture-private-key');
  daemon.beforeRequest((request) => {
    if (request.path.includes('/logs?')) {
      const helper = daemon.containers.get(START_HELPER);
      if (helper) helper.Config.Labels = { 'dsh-team.user': 'foreign-user' };
    }
  });
  const error: unknown = await startUserContainer(input).catch((failure: unknown) => failure);
  expect(String(error)).toMatch(/managed composition; managed composition cleanup failed/);
  expect(String(error) + JSON.stringify(error)).not.toContain('fixture-private-key');
  expect(daemon.requests.filter((request) => request.method === 'DELETE')).toEqual([]);
});

it.each([
  ['image resolution', 'GET', '/images/dsh-team-user%3Alocal/json'],
  ['owned volumes', 'POST', '/volumes/create'],
  ['managed composition', 'POST', `/containers/${START_HELPER}/start`],
  ['managed composition', 'POST', `/containers/${START_HELPER}/wait?condition=not-running`],
  ['container creation', 'POST', '/containers/create?name=dsh-team-u-abcdefghijkl'],
  ['container start', 'POST', `/containers/${START_CONTAINER}/start`],
])('reports only the safe %s category on Docker failure', async (stage, method, path) => {
  const { daemon, input } = await fixture();
  daemon.overrides.set(`${method} ${path}`, {
    status: 500,
    document: { message: 'fixture-private-key' },
  });
  const error: unknown = await startUserContainer(input).catch((failure: unknown) => failure);
  expect(String(error)).toContain(stage);
  expect(String(error) + JSON.stringify(error)).not.toContain('fixture-private-key');
  expect(daemon.containers.has(START_HELPER)).toBe(false);
  expect(
    daemon.requests.some(
      (request) => request.method === 'DELETE' && request.path.startsWith('/volumes/'),
    ),
  ).toBe(false);
});

it.each([
  { '3080/tcp': [{ HostIp: '0.0.0.0', HostPort: '49173' }] },
  { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
  { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '65536' }] },
  {
    '3080/tcp': [
      { HostIp: '127.0.0.1', HostPort: '49173' },
      { HostIp: '::', HostPort: '49173' },
    ],
  },
  { '3080/tcp': null },
  {},
])(
  'rejects an unusable or non-loopback inspect endpoint without reporting success',
  async (ports) => {
    const { daemon, input } = await fixture();
    daemon.beforeRequest((request) => {
      if (request.path === `/containers/${START_CONTAINER}/json`) {
        const container = daemon.containers.get(START_CONTAINER);
        if (container) container.NetworkSettings.Ports = ports;
      }
    });
    await expect(startUserContainer(input)).rejects.toThrow(/started container inspection/);
  },
);
it('refuses to start a foreign container identity returned by create', async () => {
  const { daemon, input } = await fixture();
  daemon.containers.set(START_CONTAINER, {
    Id: START_CONTAINER,
    Name: '/foreign-instance',
    Image: START_IMAGE,
    Config: { Labels: { 'dsh-team.user': 'mnopqrstuvwx' } },
    State: { Running: false },
    NetworkSettings: { Ports: {} },
  });
  daemon.overrides.set('POST /containers/create?name=dsh-team-u-abcdefghijkl', {
    status: 201,
    document: { Id: START_CONTAINER },
  });

  await expect(startUserContainer(input)).rejects.toThrow(/created container inspection/);
  expect(
    daemon.requests.some(
      (request) => request.path === '/containers/create?name=dsh-team-u-abcdefghijkl',
    ),
  ).toBe(true);

  expect(daemon.containers.get(START_CONTAINER)?.State.Running).toBe(false);
  expect(
    daemon.requests.some((request) => request.path === `/containers/${START_CONTAINER}/start`),
  ).toBe(false);
});

it('refuses to start or remove a helper whose invocation label differs from its creation request', async () => {
  const { daemon, input } = await fixture();
  daemon.beforeRequest((request) => {
    if (request.path === `/containers/${START_HELPER}/json`) {
      const helper = daemon.containers.get(START_HELPER);
      if (helper)
        helper.Config.Labels = {
          'dsh-team.user': START_USER,
          'dsh-team.role': 'managed-composition',
          'dsh-team.invocation': 'foreign-invocation',
        };
    }
  });

  await expect(startUserContainer(input)).rejects.toThrow(
    /managed composition; managed composition cleanup failed/,
  );

  expect(daemon.containers.get(START_HELPER)?.State.Running).toBe(false);
  expect(
    daemon.requests.some(
      (request) =>
        request.path === `/containers/${START_HELPER}/start` || request.method === 'DELETE',
    ),
  ).toBe(false);
});

it.each([
  ['image resolution', 'GET /images/dsh-team-user%3Alocal/json', { Id: 'mutable-tag' }],
  ['image resolution', 'GET /images/dsh-team-user%3Alocal/json', null],
  [
    'owned volumes',
    'POST /volumes/create',
    { Name: 'dsh-team-home-abcdefghijkl', Labels: { 'dsh-team.user': 'foreign-owner' } },
  ],
  [
    'managed composition',
    `POST /containers/${START_HELPER}/wait?condition=not-running`,
    { StatusCode: 1 },
  ],
  [
    'container creation',
    'POST /containers/create?name=dsh-team-u-abcdefghijkl',
    { Id: 'not-an-id' },
  ],
])(
  'rejects invalid daemon data during %s without a started instance',
  async (stage, route, document) => {
    const { daemon, input } = await fixture();
    daemon.overrides.set(route, { status: 200, document });

    await expect(startUserContainer(input)).rejects.toThrow(stage);

    expect(
      daemon.requests.some((request) => request.path === `/containers/${START_CONTAINER}/start`),
    ).toBe(false);
    expect(daemon.containers.has(START_HELPER)).toBe(false);
  },
);

it('rejects an unreadable seccomp profile before image resolution or volume creation', async () => {
  const { daemon, input } = await fixture();
  await rm(input.config.seccompProfilePath);

  await expect(startUserContainer(input)).rejects.toThrow(/seccomp policy/);

  expect(daemon.requests.map((request) => request.method)).toEqual(['GET']);
});

it.each(['DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'NODE_OPTIONS', 'KEY=wrong'])(
  'rejects model-key environment name %s before Docker side effects',
  async (apiKeyEnv) => {
    const { daemon, input } = await fixture();

    await expect(
      startUserContainer({ ...input, modelSettings: { ...START_MODEL, apiKeyEnv } }),
    ).rejects.toThrow(/model environment validation/);

    expect(daemon.requests).toEqual([]);
  },
);
