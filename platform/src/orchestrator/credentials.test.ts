import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, RequestOptions } from 'node:http';
import type * as NodeHttp from 'node:http';
import { beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseHandle } from '../db/index.ts';
import { createDockerClient, createOrchestrator } from './index.ts';
import type { Orchestrator } from './index.ts';
import {
  startupDaemon,
  START_CONTAINER,
  START_IMAGE,
  START_USER,
} from '../../test/container-start-fixture.ts';

const http = vi.hoisted(() => ({
  status: 303,
  headers: [] as string[],
  fail: false,
  observedHost: '',
  requests: 0,
}));
vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof NodeHttp>();
  return {
    ...original,
    request: (options: RequestOptions, receive: (response: IncomingMessage) => void) => {
      const outgoing = new EventEmitter();
      http.requests += 1;
      http.observedHost =
        options.headers !== undefined &&
        'Host' in options.headers &&
        typeof options.headers.Host === 'string'
          ? options.headers.Host
          : '';
      return Object.assign(outgoing, {
        end() {
          queueMicrotask(() => {
            if (http.fail) {
              outgoing.emit('error', new Error('unsafe external error'));
              return;
            }
            const response = Object.assign(new PassThrough(), {
              statusCode: http.status,
              headers: { 'set-cookie': http.headers },
            });
            // IncomingMessage's runtime fields consumed here are provided by the external HTTP fixture.
            receive(response as unknown as IncomingMessage);
          });
        },
        destroy() {
          outgoing.removeAllListeners();
        },
      });
    },
  };
});

const authority = 'team.example:8443';
const name = 'dsh-auth-3eo-BcKCoQv18vgqA6jsyDZEVweseAZ0c-hb0sOZg64';
let row: unknown;
let credential: unknown;
let clearChanges: number;
let storeChanges: number;
let cookie: string;
let database: DatabaseHandle;
let acquireDshCookie: Orchestrator['acquireDshCookie'];

beforeEach(() => {
  row = {
    container_id: START_CONTAINER,
    upstream_host: '127.0.0.1',
    upstream_port: 49173,
    image_tag: 'dsh-team-user:local',
    image_id: START_IMAGE,
    last_started_at: 1,
  };
  credential = 'previous';
  clearChanges = 1;
  storeChanges = 1;
  const body = Buffer.from(
    JSON.stringify({ version: 1, authority, issuedAt: 1, expiresAt: 8_000_000_000_000 }),
  ).toString('base64url');
  cookie = `${name}=v1.${body}.${randomBytes(32).toString('base64url')}`;
  http.status = 303;
  http.headers = [`${cookie}; Path=/; HttpOnly`];
  http.fail = false;
  http.requests = 0;
  // SQLite is mocked only as an external boundary; durable races/rollback use real SQLite integration.
  database = {
    prepare: () => ({
      get: () => row,
      run: (...values: unknown[]) => {
        const clearing = values[0] === START_USER;
        const changes = clearing ? clearChanges : storeChanges;
        if (changes === 1) credential = clearing ? null : values[0];
        return { changes };
      },
    }),
  } as unknown as DatabaseHandle;
});

function fixture() {
  const daemon = startupDaemon();
  daemon.containers.set(START_CONTAINER, {
    Id: START_CONTAINER,
    Name: `/dsh-team-u-${START_USER}`,
    Image: START_IMAGE,
    Config: { Labels: { 'dsh-team.user': START_USER } },
    State: { Running: true },
    NetworkSettings: { Ports: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49173' }] } },
  });
  daemon.attachOwnedNetwork(START_USER, START_CONTAINER);
  daemon.setComposition(`boot\ndsh web: http://127.0.0.1:3080/?token=release-token\n`);
  const client = createDockerClient('/fixture/docker.sock', daemon.transport);
  ({ acquireDshCookie } = createOrchestrator({
    client,
    database,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  }));
  return {
    daemon,
    input: {
      userId: START_USER,
      authority,
    },
  };
}

it('stores only the released authentication cookie without marking the instance ready or returning credentials', async () => {
  const { input } = fixture();
  http.headers.unshift('unrelated=discard; Path=/');

  let result: unknown;
  await acquireDshCookie(input).then((value: unknown) => {
    result = value;
  });

  expect(result === undefined).toBe(true);
  expect(credential === cookie).toBe(true);
  expect(http.observedHost).toBe(authority);
});

it.each([
  undefined,
  null,
  { container_id: 'bad' },
  { container_id: START_CONTAINER, upstream_host: 'remote' },
  { container_id: START_CONTAINER, upstream_host: '127.0.0.1', upstream_port: 0 },
  { container_id: START_CONTAINER, upstream_host: '127.0.0.1', upstream_port: 65536 },
  { container_id: START_CONTAINER, upstream_host: '127.0.0.1', upstream_port: 1, image_tag: '' },
  {
    container_id: START_CONTAINER,
    upstream_host: '127.0.0.1',
    upstream_port: 1,
    image_tag: 'image',
    last_started_at: null,
  },
])('refuses an unavailable or invalid indexed instance', async (value) => {
  const { input, daemon } = fixture();
  row = value;

  await expect(acquireDshCookie(input)).rejects.toThrow('current instance');

  expect(credential).toBe('previous');
  expect(daemon.requests).toEqual([]);
});

it('rejects an invalid user without consuming another account credential', async () => {
  const { input, daemon } = fixture();
  await expect(acquireDshCookie({ ...input, userId: '../foreign' })).rejects.toThrow(
    'current instance',
  );
  expect(credential).toBe('previous');
  expect(daemon.requests).toEqual([]);
});

it.each([
  '',
  'http://team.example',
  'team.example/path',
  'team.example@remote',
  'team.example\\invalid',
])('fails closed on malformed authority %s after clearing selected credential', async (value) => {
  const { input, daemon } = fixture();
  await expect(acquireDshCookie({ ...input, authority: value })).rejects.toThrow('authority');
  expect(credential).toBeNull();
  expect(daemon.requests).toEqual([]);
});

it.each([undefined, null, 'mutable-tag', 42])(
  'rejects absent or malformed recorded immutable image identity before clearing credentials',
  async (imageId) => {
    const { input, daemon } = fixture();
    row = {
      container_id: START_CONTAINER,
      upstream_host: '127.0.0.1',
      upstream_port: 49173,
      image_tag: 'dsh-team-user:local',
      image_id: imageId,
      last_started_at: 1,
    };

    await expect(acquireDshCookie(input)).rejects.toThrow('current instance');

    expect(credential).toBe('previous');
    expect(daemon.requests).toEqual([]);
    expect(http.requests).toBe(0);
  },
);

it.each(['no-line', 'partial', 'oversized', 'stderr', 'truncated'])(
  'does not exchange %s Docker logs',
  async (kind) => {
    const { input, daemon } = fixture();
    const path = `/containers/${START_CONTAINER}/logs?stdout=true&stderr=true&follow=true`;
    if (kind === 'no-line') daemon.setComposition('not a launch line\n');
    if (kind === 'partial') daemon.setComposition('dsh web: http://127.0.0.1:3080/?token=prefix');
    if (kind === 'oversized') daemon.setComposition('x'.repeat(16 * 1024 + 1));
    if (kind === 'stderr') {
      const data = Buffer.from('dsh web: http://127.0.0.1:3080/?token=stderr-token\n');
      const header = Buffer.alloc(8);
      header[0] = 2;
      header.writeUInt32BE(data.length, 4);
      daemon.overrides.set(`GET ${path}`, { status: 200, bytes: Buffer.concat([header, data]) });
    }
    if (kind === 'truncated')
      daemon.overrides.set(`GET ${path}`, { status: 200, bytes: Buffer.from([1, 0]) });
    await expect(acquireDshCookie(input)).rejects.toThrow('launch announcement');
    expect(credential).toBeNull();
    expect(http.requests).toBe(0);
  },
);

function invalidCookiePayload(kind: string): string {
  const payload =
    kind === 'payload'
      ? null
      : {
          version: 1,
          authority: kind === 'audience' ? 'foreign' : authority,
          issuedAt: 1,
          expiresAt: kind === 'expired' ? 2 : 8_000_000_000_000,
        };
  return `${name}=v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
}

it.each([
  'status',
  'absent',
  'unrelated',
  'duplicate',
  'version',
  'signature',
  'base64',
  'json',
  'audience',
  'payload',
  'expired',
  'huge',
  'transport',
])('rejects %s authentication response without restoring the old credential', async (kind) => {
  const { input } = fixture();
  if (kind === 'status') http.status = 302;
  if (kind === 'absent') http.headers = [];
  if (kind === 'unrelated') http.headers = ['unrelated=discard'];
  if (kind === 'duplicate') http.headers.push(cookie);
  if (kind === 'version') http.headers = [cookie.replace('=v1.', '=v2.')];
  if (kind === 'signature') http.headers = [`${name}=v1.e30.c2hvcnQ`];
  if (kind === 'base64') http.headers = [`${name}=v1.A.${randomBytes(32).toString('base64url')}`];
  if (kind === 'json')
    http.headers = [`${name}=v1.bm90LWpzb24.${randomBytes(32).toString('base64url')}`];
  if (['audience', 'payload', 'expired'].includes(kind)) {
    http.headers = [invalidCookiePayload(kind)];
  }
  if (kind === 'huge') http.headers = [`${name}=v1.${'x'.repeat(5000)}.x`];
  if (kind === 'transport') http.fail = true;

  await expect(acquireDshCookie(input)).rejects.toThrow('HTTP exchange');

  expect(credential).toBeNull();
});

it.each(['clear', 'store'])(
  'refuses a zero-row %s without overwriting the current credential',
  async (phase) => {
    const { input } = fixture();
    if (phase === 'clear') clearChanges = 0;
    else storeChanges = 0;
    await expect(acquireDshCookie(input)).rejects.toThrow(
      phase === 'clear' ? 'current instance' : 'persistence',
    );
    expect(credential).toBe(phase === 'clear' ? 'previous' : null);
  },
);

it('preserves the selected credential when canceled before acquisition begins without exposing abort reason', async () => {
  const { input, daemon } = fixture();
  const signal = AbortSignal.abort(new Error(cookie));
  let message = '';
  try {
    await acquireDshCookie({ ...input, signal });
  } catch (error) {
    if (error instanceof Error) message = JSON.stringify(error, Object.getOwnPropertyNames(error));
  }
  expect(message.includes(cookie)).toBe(false);
  expect(credential).toBe('previous');
  expect(daemon.requests).toEqual([]);
});

it.each([
  { upstream_port: '49173' },
  { upstream_port: 1.5 },
  { image_tag: 42 },
  { last_started_at: 1.5 },
  { container_id: 42 },
])('rejects malformed persisted endpoint, image and startup identity fields', async (fields) => {
  const { input } = fixture();
  row = {
    container_id: START_CONTAINER,
    upstream_host: '127.0.0.1',
    upstream_port: 49173,
    image_tag: 'dsh-team-user:local',
    image_id: START_IMAGE,
    last_started_at: 1,
    ...fields,
  };

  await expect(acquireDshCookie(input)).rejects.toThrow('current instance');

  expect(credential).toBe('previous');
});

it.each([
  {},
  { version: 2 },
  { authority: null },
  { issuedAt: null },
  { issuedAt: 1.5 },
  { expiresAt: null },
  { expiresAt: 1.5 },
  { expiresAt: 1 },
])('refuses an invalid released cookie payload field', async (fields) => {
  const { input } = fixture();
  const payload =
    Object.keys(fields).length === 0
      ? {}
      : { version: 1, authority, issuedAt: 1, expiresAt: 8_000_000_000_000, ...fields };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  http.headers = [`${name}=v1.${body}.${randomBytes(32).toString('base64url')}`];

  await expect(acquireDshCookie(input)).rejects.toThrow('HTTP exchange');

  expect(credential).toBeNull();
});

it('preserves explicit Host while validating the released normalized default-port cookie audience', async () => {
  const { input } = fixture();
  const payload = {
    version: 1,
    authority: 'team.example',
    issuedAt: 1,
    expiresAt: 8_000_000_000_000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const expected = `dsh-auth-XrXWM2Z9IIODwCWai-VITu4r1KoAdS1pibz3Jh-D2S8=v1.${body}.${randomBytes(32).toString('base64url')}`;
  http.headers = [expected];

  await acquireDshCookie({ ...input, authority: 'team.example:80' });

  expect(http.observedHost).toBe('team.example:80');
  expect(credential === expected).toBe(true);
});
