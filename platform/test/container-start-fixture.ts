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
  StartUserContainerInput,
} from '../src/orchestrator/index.ts';

export const START_USER = 'abcdefghijkl';
export const START_IMAGE = `sha256:${'a'.repeat(64)}`;
export const START_CONTAINER = 'b'.repeat(64);
export const START_HELPER = 'c'.repeat(64);
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
interface Container {
  Id: string;
  Name: string;
  Image: unknown;
  Config: Record<string, unknown>;
  State: { Running: boolean };
  NetworkSettings: { Ports: unknown };
}

/** External Engine boundary only; composition/generation/writing/auditing remain real. */
export function startupDaemon() {
  const requests: StartupRequest[] = [];
  const containers = new Map<string, Container>();
  const overrides = new Map<string, Reply>();
  let compositionOutput = COMPOSITION;
  let nextContainerId = START_CONTAINER;
  let before: ((request: StartupRequest) => void) | undefined;
  function reply(request: StartupRequest): Reply {
    requests.push(request);
    before?.(request);
    const override = overrides.get(`${request.method} ${request.path}`);
    if (override !== undefined) return override;
    const { method, path, body } = request;
    if (path.startsWith('/images/')) return { status: 200, document: { Id: START_IMAGE } };
    if (path === '/volumes/create') return { status: 201, document: body };
    if (path.startsWith('/containers/create?')) {
      const name = new URL(`http://docker${path}`).searchParams.get('name') ?? '';
      const helper = name.startsWith('dsh-team-compose-');
      const container: Container = {
        Id: helper ? START_HELPER : nextContainerId,
        Name: `/${name}`,
        Image: body.Image,
        Config: body,
        State: { Running: false },
        NetworkSettings: { Ports: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49173' }] } },
      };
      containers.set(container.Id, container);
      return { status: 201, document: { Id: container.Id } };
    }
    const target = new URL(`http://docker${path}`).pathname.split('/')[2];
    const container = [...containers.values()].find(
      (row) => row.Id === target || row.Name === `/${target ?? ''}`,
    );
    if (container === undefined) return { status: 404, document: { message: 'not found' } };
    if (method === 'DELETE') {
      containers.delete(container.Id);
      return { status: 204 };
    }
    if (path.endsWith('/json')) return { status: 200, document: container };
    if (path.startsWith(`/containers/${container.Id}/stop?`)) {
      container.State.Running = false;
      return { status: 204 };
    }
    if (path.endsWith('/start')) {
      container.State.Running = true;
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
    overrides,
    reply,
    transport,
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
  daemon: { requests: readonly StartupRequest[]; containers: ReadonlyMap<string, Container> },
) {
  const changes: unknown = database.prepare('SELECT total_changes() AS count').get();
  return {
    current: await startupEvidence(database, input),
    rows: database.prepare('SELECT * FROM instances ORDER BY user_id').all(),
    changes,
    requests: structuredClone(daemon.requests),
    containers: structuredClone([...daemon.containers]),
  };
}

export function expectDockerReads(
  requests: readonly StartupRequest[],
  count: number,
  ...paths: string[]
): void {
  expect(requests.slice(count).map(({ method, path }) => ({ method, path }))).toEqual(
    paths.map((path) => ({ method: 'GET', path })),
  );
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
    async json(method, path, body, signal) {
      await before?.(method, path, signal);
      return raw.json(method, path, body, signal);
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
