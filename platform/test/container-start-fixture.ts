import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { expect } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createDockerClient, createOrchestrator } from '../src/orchestrator/index.ts';
import type {
  DockerTransport,
  OrchestratorDependencies,
  Orchestrator,
  StartUserContainerInput,
} from '../src/orchestrator/index.ts';

export const START_USER = 'abcdefghijkl';
export const START_IMAGE = `sha256:${'a'.repeat(64)}`;
export const START_CONTAINER = 'b'.repeat(64);
export const START_HELPER = 'c'.repeat(64);
export const START_NETWORK = 'e'.repeat(64);
export const START_MODEL = {
  baseURL: 'http://model.invalid/v1',
  apiKeyEnv: 'DMXAPI_KEY',
  models: [{ name: 'office-model' }],
  defaultModel: 'office-model',
};
export const START_PERMISSION: StartUserContainerInput['permission'] = {
  presets: { ask: { sandbox: 'workspace-write', approval: 'ask' } },
  defaultPreset: 'ask',
};
const COMPOSITION = JSON.stringify({
  skippedBundles: [],
  entries: [
    {
      id: 'assistant',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'assistant',
        plugins: [{ name: '@deepseek-ai/dsh-tool-web' }, { name: '@deepseek-ai/dsh-tool-bash' }],
      },
    },
  ],
  localePatch: [{ id: 'locale', name: '@dsh-team/zh-locale' }],
});

export interface StartupRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}
interface Reply {
  status: number;
  document?: unknown;
  bytes?: Buffer;
}
export interface Container {
  Id: string;
  Name: string;
  Image: unknown;
  Config: Record<string, unknown>;
  HostConfig?: Record<string, unknown>;
  State: { Running: boolean };
  NetworkSettings: { Ports: unknown; Networks?: Record<string, unknown> };
}

export interface StartupNetwork {
  Id: string;
  Name: string;
  Driver: string;
  Internal: boolean;
  EnableIPv6: boolean;
  Labels: unknown;
  IPAM: unknown;
  Containers: Record<string, { Name: string; IPv4Address: string; EndpointID?: string }>;
}

export interface StartupDaemon {
  requests: StartupRequest[];
  containers: Map<string, Container>;
  networks: Map<string, StartupNetwork>;
  overrides: Map<string, Reply>;
  reply: (request: StartupRequest) => Reply;
  transport: DockerTransport;
  attachOwnedNetwork: (user: string, id: string) => void;
  removeContainer: (id: string) => void;
  setContainerId: (value: string) => void;
  setComposition: (value?: string) => void;
  beforeRequest: (callback: (request: StartupRequest) => void) => void;
}

export interface StartupOwnerFixture {
  root: string;
  database: DatabaseHandle;
  daemon: StartupDaemon;
  client: OrchestratorDependencies['client'];
  owner: Orchestrator;
  input: StartUserContainerInput;
  beforeRequest: (
    callback:
      ((method: string, path: string, signal?: AbortSignal) => Promise<undefined>) | undefined,
  ) => void;
}

function networkObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Malformed fixture network request');
  // Docker request bodies are decoded JSON; narrow fields at this external boundary.
  return value as Record<string, unknown>;
}

function startupNetworks(containers: ReadonlyMap<string, Container>) {
  const networks = new Map<string, StartupNetwork>();
  let sequence = 1;
  networks.set('0'.repeat(64), {
    Id: '0'.repeat(64),
    Name: 'bridge',
    Driver: 'bridge',
    Internal: false,
    EnableIPv6: false,
    Labels: {},
    IPAM: { Driver: 'default', Config: [{ Subnet: '172.17.0.0/16' }] },
    Containers: {},
  });
  function create(body: Record<string, unknown>): Reply {
    if ([...networks.values()].some((row) => row.Name === body.Name))
      return { status: 409, document: { message: 'network already exists' } };
    const id = sequence === 1 ? START_NETWORK : sequence.toString(16).padStart(64, '0');
    sequence += 1;
    if (networks.has(id))
      return { status: 409, document: { message: 'network identity collision' } };
    const driver = body.Driver ?? 'bridge';
    if (typeof body.Name !== 'string' || typeof driver !== 'string')
      throw new Error('Malformed fixture network identity');
    networks.set(id, {
      Id: id,
      Name: body.Name,
      Driver: driver,
      Internal: body.Internal === true,
      EnableIPv6: body.EnableIPv6 === true,
      Labels: body.Labels ?? {},
      IPAM: body.IPAM ?? { Driver: 'default', Config: [] },
      Containers: {},
    });
    return { status: 201, document: { Id: id, Warning: '' } };
  }
  function disconnect(row: StartupNetwork, body: Record<string, unknown>): Reply {
    if (body.Force === true) throw new Error('Fixture refuses forced endpoint disconnection');
    Reflect.deleteProperty(row.Containers, String(body.Container));
    const container = containers.get(String(body.Container));
    if (container?.NetworkSettings.Networks !== undefined)
      Reflect.deleteProperty(container.NetworkSettings.Networks, row.Name);
    return { status: 200 };
  }
  function reply({ method, path, body }: StartupRequest): Reply | undefined {
    const url = new URL(`http://docker${path}`);
    if (method === 'GET' && url.pathname === '/networks')
      return { status: 200, document: [...networks.values()] };
    if (method === 'POST' && url.pathname === '/networks/create') return create(body);
    if (!url.pathname.startsWith('/networks/')) return undefined;
    const target = decodeURIComponent(url.pathname.split('/')[2] ?? '');
    const row = [...networks.values()].find((item) => item.Id === target || item.Name === target);
    if (row === undefined) return { status: 404, document: { message: 'network not found' } };
    if (method === 'GET') return { status: 200, document: row };
    if (method === 'DELETE') {
      if (Object.keys(row.Containers).length !== 0)
        return { status: 409, document: { message: 'network has active endpoints' } };
      networks.delete(row.Id);
      return { status: 204 };
    }
    if (method === 'POST' && url.pathname.endsWith('/disconnect')) return disconnect(row, body);
    throw new Error('Unexpected fixture network operation');
  }
  function attach(container: Container, body: Record<string, unknown>) {
    const mode = networkObject(body.HostConfig).NetworkMode ?? 'bridge';
    const attached: Record<string, unknown> = {};
    if (mode === 'none') return attached;
    const row = [...networks.values()].find((item) => item.Id === mode || item.Name === mode);
    if (row === undefined) throw new Error('Fixture container network does not exist');
    const requested =
      body.NetworkingConfig === undefined
        ? {}
        : networkObject(networkObject(body.NetworkingConfig).EndpointsConfig);
    const endpoint = requested[row.Id] ?? requested[row.Name] ?? {};
    const config = networkObject(row.IPAM).Config;
    if (!Array.isArray(config)) throw new Error('Fixture network has no IPAM config');
    const subnet = networkObject(config[0]).Subnet;
    if (typeof subnet !== 'string') throw new Error('Fixture network has no subnet');
    const [base, prefix] = subnet.split('/');
    const octets = (base ?? '').split('.');
    octets[3] = String(Number(octets[3]) + 2);
    const address = octets.join('.');
    row.Containers[container.Id] = {
      Name: container.Name.slice(1),
      IPv4Address: `${address}/${prefix ?? ''}`,
      EndpointID: container.Id,
    };
    attached[row.Name] = {
      NetworkID: row.Id,
      EndpointID: container.Id,
      IPAddress: address,
      Aliases: networkObject(endpoint).Aliases ?? null,
    };
    return attached;
  }
  return { networks, reply, attach };
}

/** External Engine boundary only; composition/generation/writing/auditing remain real. */
export function startupDaemon(): StartupDaemon {
  const requests: StartupRequest[] = [];
  const containers = new Map<string, Container>();
  const overrides = new Map<string, Reply>();
  const networkState = startupNetworks(containers);
  let compositionOutput = COMPOSITION;
  let nextContainerId = START_CONTAINER;
  let before: ((request: StartupRequest) => void) | undefined;
  function removeContainer(id: string): void {
    containers.delete(id);
    for (const network of networkState.networks.values())
      Reflect.deleteProperty(network.Containers, id);
  }
  function discoveryReply(request: StartupRequest): Reply | undefined {
    const override = overrides.get(`${request.method} ${request.path}`);
    if (override !== undefined) return override;
    if (request.method !== 'GET' || !request.path.startsWith('/containers/json?')) return undefined;
    return {
      status: 200,
      document: [...containers.values()].map((container) => ({
        Id: container.Id,
        Names: [container.Name],
        ImageID: container.Image,
        Labels: container.Config.Labels,
        State: container.State.Running ? 'running' : 'exited',
      })),
    };
  }
  function createContainer(path: string, body: Record<string, unknown>): Reply {
    const name = new URL(`http://docker${path}`).searchParams.get('name') ?? '';
    const helper = name.startsWith('dsh-team-compose-');
    const container: Container = {
      Id: helper ? START_HELPER : nextContainerId,
      Name: `/${name}`,
      Image: body.Image,
      Config: body,
      HostConfig: networkObject(body.HostConfig),
      State: { Running: false },
      NetworkSettings: { Ports: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49173' }] } },
    };
    container.NetworkSettings.Networks = networkState.attach(container, body);
    containers.set(container.Id, container);
    return { status: 201, document: { Id: container.Id } };
  }
  function reply(request: StartupRequest): Reply {
    requests.push(request);
    before?.(request);
    const override = discoveryReply(request);
    if (override !== undefined) return override;
    const networkReply = networkState.reply(request);
    if (networkReply !== undefined) return networkReply;
    const { method, path, body } = request;
    if (path.startsWith('/images/')) return { status: 200, document: { Id: START_IMAGE } };
    if (path === '/volumes/create') return { status: 201, document: body };
    if (path.startsWith('/containers/create?')) return createContainer(path, body);
    const target = new URL(`http://docker${path}`).pathname.split('/')[2];
    const container = [...containers.values()].find(
      (row) => row.Id === target || row.Name === `/${target ?? ''}`,
    );
    if (container === undefined) return { status: 404, document: { message: 'not found' } };
    if (method === 'DELETE') {
      removeContainer(container.Id);
      return { status: 204 };
    }
    if (path.endsWith('/json')) return { status: 200, document: container };
    if (path.startsWith(`/containers/${container.Id}/stop?`)) {
      container.State.Running = false;
      return { status: 204 };
    }
    if (path.endsWith('/start')) {
      container.State.Running = true;
      container.NetworkSettings.Networks = networkState.attach(container, container.Config);
      return { status: 204 };
    }
    if (path.includes('/wait?')) return { status: 200, document: { StatusCode: 0 } };
    if (path.includes('/logs?')) {
      const bytes = Buffer.from(compositionOutput);
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(bytes.length, 4);
      return { status: 200, bytes: Buffer.concat([header, bytes]) };
    }
    throw new Error('Unexpected fixture Docker operation');
  }
  const transport: DockerTransport = (options, receive) => {
    const chunks: Buffer[] = [];
    return new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
      final(done) {
        try {
          // All bodies here come from the real client's JSON serializer, not application input.
          const body =
            chunks.length === 0
              ? {}
              : (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
          const response = reply({ method: options.method ?? '', path: options.path ?? '', body });
          const bytes =
            response.bytes ??
            (response.document === undefined
              ? Buffer.alloc(0)
              : Buffer.from(JSON.stringify(response.document)));
          const stream: Readable & { statusCode?: number } = Readable.from([bytes]);
          stream.statusCode = response.status;
          queueMicrotask(() => {
            receive(stream);
          });
          done();
        } catch (error) {
          done(error instanceof Error ? error : new Error('Fixture failure'));
        }
      },
    });
  };
  return {
    requests,
    containers,
    networks: networkState.networks,
    overrides,
    reply,
    transport,
    removeContainer,
    attachOwnedNetwork(userId: string, id: string) {
      const container = containers.get(id);
      if (container === undefined) throw new Error('Fixture seed container missing');
      const name = `dsh-team-net-${userId}`;
      const created = networkState.reply({
        method: 'POST',
        path: '/networks/create',
        body: {
          Name: name,
          Driver: 'bridge',
          Labels: { 'dsh-team.user': userId },
          IPAM: { Driver: 'default', Config: [{ Subnet: '172.30.0.0/28' }] },
        },
      });
      const network = networkObject(created?.document).Id;
      container.HostConfig = { NetworkMode: network };
      container.NetworkSettings.Networks = networkState.attach(container, {
        HostConfig: { NetworkMode: network },
        NetworkingConfig: { EndpointsConfig: { [String(network)]: { Aliases: [`u-${userId}`] } } },
      });
    },
    setContainerId(value: string) {
      nextContainerId = value;
    },
    setComposition(value: string = COMPOSITION) {
      compositionOutput = value;
    },
    beforeRequest(callback: (request: StartupRequest) => void) {
      before = callback;
    },
  };
}

export async function startupEvidence(database: DatabaseHandle, input: StartUserContainerInput) {
  const overlay = join(input.config.managedConfigDir, `${input.userId}.patch.yml`);
  return {
    row: database.prepare('SELECT * FROM instances WHERE user_id = ?').get(input.userId),
    audit: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
    bytes: await readFile(overlay),
    inode: (await stat(overlay)).ino,
  };
}

export async function startupCapacityEvidence(
  database: DatabaseHandle,
  input: StartUserContainerInput,
  daemon: Pick<StartupDaemon, 'requests' | 'containers' | 'networks'>,
) {
  const changes: unknown = database.prepare('SELECT total_changes() AS count').get();
  return {
    current: await startupEvidence(database, input),
    rows: database.prepare('SELECT * FROM instances ORDER BY user_id').all(),
    changes,
    requests: structuredClone(daemon.requests),
    containers: structuredClone([...daemon.containers]),
    networks: structuredClone([...daemon.networks]),
  };
}

export function expectDockerReads(
  requests: readonly StartupRequest[],
  count: number,
  ...paths: string[]
): void {
  const reads = requests.slice(count);
  expect(reads.every(({ method }) => method === 'GET')).toBe(true);
  expect(
    reads
      .filter(({ path }) => !path.startsWith('/networks'))
      .map(({ method, path }) => ({ method, path })),
  ).toEqual(paths.map((path) => ({ method: 'GET', path })));
}

export function startupBarrier() {
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  return {
    reached: reached.promise,
    release() {
      release.resolve(undefined);
    },
    async hold(): Promise<undefined> {
      reached.resolve(undefined);
      await release.promise;
      return undefined;
    },
  };
}

/** Reusable public-owner fixture with actual SQLite; callers own closing/removing its resources. */
export async function startupOwnerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-owner-'));
  const database = openDatabase(':memory:');
  applyMigrations(database);
  for (const user of [START_USER, 'mnopqrstuvwx']) {
    database
      .prepare("INSERT INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
      .run(user, `${user}@example.test`);
  }
  const seccompProfilePath = join(root, 'seccomp.json');
  await writeFile(seccompProfilePath, '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}');
  const daemon = startupDaemon();
  const raw = createDockerClient('/fixture/docker.sock', daemon.transport);
  let before:
    ((method: string, path: string, signal?: AbortSignal) => Promise<undefined>) | undefined;
  const client: OrchestratorDependencies['client'] = {
    ...raw,
    async json(method, path, body, signal, maxBytes) {
      await before?.(method, path, signal);
      return raw.json(method, path, body, signal, maxBytes);
    },
  };
  const owner = createOrchestrator({ client, database });
  const input: StartUserContainerInput = {
    userId: START_USER,
    config: {
      userImage: 'dsh-team-user:local',
      seccompProfilePath,
      managedConfigDir: join(root, 'managed'),
      authority: 'team.example:8443',
      subnetPool: '172.30.0.0/16',
    },
    modelSettings: START_MODEL,
    modelKey: 'fixture-private-key',
    permission: START_PERMISSION,
  };
  return {
    root,
    database,
    daemon,
    client,
    owner,
    input,
    beforeRequest: (callback: typeof before) => {
      before = callback;
    },
    blockStartup: async () => {
      const gate = startupBarrier();
      before = async (method, path) => {
        if (method === 'POST' && path === `/containers/create?name=dsh-team-u-${START_USER}`)
          await gate.hold();
        return undefined;
      };
      const first = owner.startUserContainer(input);
      const head = Promise.allSettled([first]);
      await gate.reached;
      return { gate, first, head };
    },
  };
}

/** Real Unix HTTP fixture; barriers delay the Engine response, not the public lifecycle method. */
export function startupUnixServer(
  reply: (request: StartupRequest) => Reply,
  hold: (method: string, path: string) => Promise<undefined> | undefined,
) {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const method = request.method ?? '';
      const path = request.url ?? '';
      const send = () => {
        try {
          // Bodies come only from the real Docker client's JSON serializer.
          const body =
            chunks.length === 0
              ? {}
              : (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
          const result = reply({ method, path, body });
          response
            .writeHead(result.status)
            .end(
              result.bytes ??
                (result.document === undefined ? '' : JSON.stringify(result.document)),
            );
        } catch {
          response.writeHead(500).end();
        }
      };
      const waiting = hold(method, path);
      if (waiting === undefined) send();
      else void waiting.then(send);
    });
  });
}

export const CREATED_AND_STARTED = [
  {
    event_type: 'instance.created',
    target: START_USER,
    target_email: 'employee@example.test',
    details: '{}',
  },
  {
    event_type: 'instance.started',
    target: START_USER,
    target_email: 'employee@example.test',
    details: '{}',
  },
];
