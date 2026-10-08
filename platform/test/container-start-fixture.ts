import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { expect } from 'vitest';
import type { DatabaseHandle } from '../src/db/index.ts';
import type { DockerTransport, StartUserContainerInput } from '../src/orchestrator/index.ts';

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
    setComposition(value: string) {
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

export function expectDockerReads(
  requests: readonly StartupRequest[],
  count: number,
  ...paths: string[]
): void {
  expect(requests.slice(count).map(({ method, path }) => ({ method, path }))).toEqual(
    paths.map((path) => ({ method: 'GET', path })),
  );
}
