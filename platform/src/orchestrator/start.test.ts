import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseHandle } from '../db/index.ts';
import { writeSettings } from '../db/index.ts';
import { createOrchestrator } from './index.ts';
import type { Orchestrator } from './index.ts';
import type { StartupRequest } from '../../test/container-start-fixture.ts';
import {
  createdEnvSecret,
  seedPlatform,
  startupOwnerFixture,
  START_CONTAINER,
  START_HELPER,
  START_IMAGE,
  START_MODEL,
  START_NETWORK,
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

const fileTokenSecret = (requests: readonly StartupRequest[]) =>
  createdEnvSecret(requests, 'DSH_TEAM_ONLYOFFICE_FILE_SECRET');
const instanceToken = (requests: readonly StartupRequest[]) =>
  createdEnvSecret(requests, 'DSH_TEAM_INSTANCE_TOKEN');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function persistedTables(tables = ['instances', 'creation_attempts', 'audit_events']): string {
  return JSON.stringify(tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all()));
}

function tokenRow(): unknown {
  return database
    .prepare('SELECT status, instance_token_hash FROM instances WHERE user_id = ?')
    .get(START_USER);
}

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
    Env: [
      'DSH_HOME=/data/home',
      'DSH_TELEMETRY_DISABLED=1',
      'DMXAPI_KEY=fixture-private-key',
      `DSH_TEAM_ONLYOFFICE_FILE_SECRET=${fileTokenSecret(daemon.requests)}`,
      `DSH_TEAM_INSTANCE_TOKEN=${instanceToken(daemon.requests)}`,
    ],
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
  expect(JSON.stringify(helpers)).not.toContain('DSH_TEAM_ONLYOFFICE_FILE_SECRET');
  expect(JSON.stringify(helpers)).not.toContain('DSH_TEAM_INSTANCE_TOKEN');
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
  ['admin', true],
  ['employee', false],
] as const)(
  'passes the current %s account role into the platform entry row',
  async (role, admin) => {
    const { input } = await fixture();
    database.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, input.userId);

    await startUserContainer(input);
    const rows: unknown = JSON.parse(
      await readFile(join(input.config.managedConfigDir, 'abcdefghijkl.patch.yml'), 'utf8'),
    );

    expect(rows).toContainEqual({
      insert: [
        {
          id: 'managed-permissions',
          name: '/opt/dsh-team/permission-tiers/index.js',
          disabled: false,
        },
        {
          id: 'platform-nav',
          name: '/opt/dsh-team/platform-nav/index.js',
          disabled: false,
          config: { admin },
        },
      ],
    });
  },
);

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

it.each([
  'DSH_HOME',
  'DSH_TELEMETRY_DISABLED',
  'DSH_TEAM_ONLYOFFICE_FILE_SECRET',
  'DSH_TEAM_INSTANCE_TOKEN',
  'NODE_OPTIONS',
  'KEY=wrong',
])('rejects model-key environment name %s before Docker side effects', async (apiKeyEnv) => {
  const { daemon, input } = await fixture();

  await expect(
    startUserContainer({ ...input, modelSettings: { ...START_MODEL, apiKeyEnv } }),
  ).rejects.toThrow(/model environment validation/);

  expect(daemon.requests).toEqual([]);
});

it('injects a fresh file-token secret per created container and persists it nowhere', async () => {
  const { daemon, input, owner } = await fixture();

  await startUserContainer(input);
  const first = fileTokenSecret(daemon.requests);
  expect(persistedTables()).not.toContain(first);
  await owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
  await startUserContainer(input);
  const second = fileTokenSecret(daemon.requests);

  expect(second).not.toBe(first);
  const tables = persistedTables();
  for (const value of [first, second]) {
    expect(tables).not.toContain(value);
    expect(
      await readFile(join(input.config.managedConfigDir, 'abcdefghijkl.patch.yml'), 'utf8'),
    ).not.toContain(value);
  }
  expect(JSON.stringify(daemon.containers.get(START_CONTAINER)?.Config.Env)).toContain(second);
});

it.each([
  ['container creation', 'POST', '/containers/create?name=dsh-team-u-abcdefghijkl'],
  ['container start', 'POST', `/containers/${START_CONTAINER}/start`],
])(
  'keeps injected secrets and the token hash out of %s failure messages, causes and saved errors',
  async (stage, method, path) => {
    const { daemon, input } = await fixture();
    const echoed = () => {
      const token = instanceToken(daemon.requests);
      return [fileTokenSecret(daemon.requests), token, sha256(token)];
    };
    daemon.beforeRequest((request) => {
      if (request.method === method && request.path === path) {
        // A hostile daemon echoes the submitted credentials back in its error body.
        const message = echoed().join(' ');
        daemon.overrides.set(`${method} ${path}`, { status: 500, document: { message } });
      }
    });

    const error: unknown = await startUserContainer(input).catch((failure: unknown) => failure);

    const [secret = '', token = '', hash = ''] = echoed();
    if (!(error instanceof Error)) throw new Error('Expected a startup failure');
    expect(error.message).toContain(stage);
    const lastError = JSON.stringify(database.prepare('SELECT last_error FROM instances').all());
    for (const value of [secret, token, hash]) {
      expect(error.message + lastError).not.toContain(value);
      expect(JSON.stringify(error.cause) + JSON.stringify(error)).not.toContain(value);
    }
    expect(persistedTables()).not.toContain(secret);
    expect(persistedTables()).not.toContain(token);
  },
);

it('persists only the hash of a fresh instance token, keeps it on reuse and rotates it on restart', async () => {
  const { daemon, input, owner } = await fixture();

  const result = await startUserContainer(input);
  const first = instanceToken(daemon.requests);
  expect(tokenRow()).toEqual({ status: 'starting', instance_token_hash: sha256(first) });
  expect(JSON.stringify(result)).not.toMatch(new RegExp(`${first}|${sha256(first)}`));
  expect(persistedTables()).not.toContain(first);
  expect(persistedTables(['creation_attempts', 'audit_events'])).not.toContain(sha256(first));
  database.prepare("UPDATE instances SET status = 'running'").run();
  const requests = daemon.requests.length;
  expect(await startUserContainer(input)).toEqual({ ...result, outcome: 'running' });
  expect(daemon.requests.slice(requests).some(({ method }) => method === 'POST')).toBe(false);
  expect(tokenRow()).toEqual({ status: 'running', instance_token_hash: sha256(first) });

  await owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
  await startUserContainer(input);
  const second = instanceToken(daemon.requests);

  expect(second).not.toBe(first);
  expect(tokenRow()).toEqual({ status: 'starting', instance_token_hash: sha256(second) });
  for (const value of [first, sha256(first), second])
    expect(persistedTables()).not.toContain(value);
});

it('clears the persisted token hash when a confirmed-started instance is compensated', async () => {
  const { daemon, client, input } = await fixture();
  seedPlatform(daemon, 'dsh-team-test-platform', 'f'.repeat(64));
  const owner = createOrchestrator({
    client,
    database,
    config: { upstreamMode: 'network', platformContainerName: 'dsh-team-test-platform' },
  });
  const connect = `/networks/${START_NETWORK}/connect`;
  daemon.overrides.set(`POST ${connect}`, { status: 403 });
  const persisted: unknown[] = [];
  daemon.beforeRequest(({ method, path }) => {
    if (method === 'POST' && path === connect) persisted.push(tokenRow());
  });

  await expect(owner.startUserContainer(input)).rejects.toThrow(
    'started container and owned network removed',
  );

  const hash = sha256(instanceToken(daemon.requests));
  expect(persisted).toEqual([{ status: 'starting', instance_token_hash: hash }]);
  expect(tokenRow()).toEqual({ status: 'error', instance_token_hash: null });
});

function networkOwner(context: Awaited<ReturnType<typeof fixture>>): Orchestrator {
  seedPlatform(context.daemon, 'dsh-team-test-platform', 'f'.repeat(64));
  return createOrchestrator({
    client: context.client,
    database,
    config: { upstreamMode: 'network', platformContainerName: 'dsh-team-test-platform' },
  });
}

function createdEndpoints(requests: readonly StartupRequest[]): unknown {
  const create = requests.find(
    ({ method, path }) =>
      method === 'POST' && path === `/containers/create?name=dsh-team-u-${START_USER}`,
  );
  return create?.body.NetworkingConfig;
}

it('declares the layout container address only in the network-mode create body', async () => {
  const network = await fixture();
  await networkOwner(network).startUserContainer(network.input);
  const loopback = await fixture();
  await loopback.owner.startUserContainer(loopback.input);

  expect(createdEndpoints(network.daemon.requests)).toEqual({
    EndpointsConfig: {
      [START_NETWORK]: { Aliases: [`u-${START_USER}`], IPAMConfig: { IPv4Address: '172.30.0.2' } },
    },
  });
  expect(createdEndpoints(loopback.daemon.requests)).toEqual({
    EndpointsConfig: { [START_NETWORK]: { Aliases: [`u-${START_USER}`] } },
  });
});

it('compensates a started container whose actual address differs from its declared layout address', async () => {
  const context = await fixture();
  const { daemon, input } = context;
  const owner = networkOwner(context);
  daemon.actualAddresses.set(START_CONTAINER, '172.30.0.5');

  await expect(owner.startUserContainer(input)).rejects.toThrow(
    'started container and owned network removed',
  );

  expect(
    database.prepare('SELECT status, last_error FROM instances WHERE user_id = ?').get(START_USER),
  ).toEqual({
    status: 'error',
    last_error: 'Platform attachment/startup failed; started container and owned network removed',
  });
  expect(
    database
      .prepare('SELECT event_type FROM audit_events ORDER BY id')
      .all()
      .map((row) => (row as { event_type: string }).event_type),
  ).toContain('instance.start-failed');
  const started = daemon.requests.findIndex(
    ({ method, path }) => method === 'POST' && path === `/containers/${START_CONTAINER}/start`,
  );
  expect(started).toBeGreaterThan(-1);
  expect(
    daemon.requests
      .slice(started + 1)
      .filter(({ method }) => method !== 'GET')
      .map(({ method, path }) => `${method} ${path}`),
  ).toEqual([
    `POST /containers/${START_CONTAINER}/stop?t=1`,
    `DELETE /containers/${START_CONTAINER}`,
    `DELETE /networks/${START_NETWORK}`,
  ]);
  expect(daemon.requests.some(({ path }) => path === `/networks/${START_NETWORK}/connect`)).toBe(
    false,
  );
  expect(
    daemon.requests.some(({ method, path }) => method === 'DELETE' && path.startsWith('/volumes/')),
  ).toBe(false);
  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(daemon.networks.has(START_NETWORK)).toBe(false);
});
