import type { FastifyInstance } from 'fastify';
import { expect, it, vi } from 'vitest';
import { withApp } from '../../test/auth-fixture.ts';
import {
  instanceToken,
  instanceTokenHash,
  seedInstance,
} from '../../test/instance-token-fixture.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { INSTANCE_ERRORS, authenticateInstance } from './instance-auth.ts';

const TOKEN = 'a1'.repeat(32);
const HOST = '172.30.0.2';
const PROBE = '/_platform/instance-api/ragflow/owned-probe';
const UNAUTHORIZED = { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' };
type Lookup = Parameters<typeof authenticateInstance>[1];

// An explicit undefined peer must stay undefined, so the address has no default.
function peer(authorization: string | undefined, remoteAddress: string | undefined) {
  return {
    headers: authorization === undefined ? {} : { authorization },
    socket: { remoteAddress },
  };
}
const unreachable = vi.fn<Lookup>(() => {
  throw new Error('the token store must not be read');
});

it('keeps fixed rejection bodies that never carry request-derived text', () => {
  expect(INSTANCE_ERRORS).toStrictEqual({
    401: UNAUTHORIZED,
    413: { statusCode: 413, error: 'Payload Too Large', message: 'Request body too large' },
    415: {
      statusCode: 415,
      error: 'Unsupported Media Type',
      message: 'JSON request body required',
    },
    500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
  });
});

it('looks up the SHA-256 of a bearer of exactly 64 lowercase hex and returns its owner', () => {
  const lookup = vi.fn<Lookup>(() => ({ user_id: 'owner', upstream_host: HOST }));

  const owner = authenticateInstance(peer(`Bearer ${TOKEN}`, HOST), lookup);

  expect(owner).toBe('owner');
  expect(lookup.mock.calls).toEqual([[instanceTokenHash(TOKEN)]]);
});

it.each([
  ['a missing header', undefined],
  ['a Basic scheme', `Basic ${TOKEN}`],
  ['a lowercase scheme', `bearer ${TOKEN}`],
  ['63 characters', `Bearer ${TOKEN.slice(1)}`],
  ['65 characters', `Bearer ${TOKEN}0`],
  ['uppercase hex', `Bearer ${TOKEN.toUpperCase()}`],
  ['non-hex characters', `Bearer ${'g'.repeat(64)}`],
  ['leading whitespace', ` Bearer ${TOKEN}`],
  ['trailing whitespace', `Bearer ${TOKEN} `],
  ['a trailing line break', `Bearer ${TOKEN}\n`],
  ['two spaces', `Bearer  ${TOKEN}`],
  ['an empty value', ''],
])('rejects %s without reading the token store', (_label, authorization) => {
  expect(authenticateInstance(peer(authorization, HOST), unreachable)).toBeNull();
  expect(unreachable).not.toHaveBeenCalled();
});

it('compares an IPv4-mapped IPv6 peer by its IPv4 address', () => {
  const lookup: Lookup = () => ({ user_id: 'owner', upstream_host: HOST });

  expect(authenticateInstance(peer(`Bearer ${TOKEN}`, `::ffff:${HOST}`), lookup)).toBe('owner');
});

it.each([
  ['an absent', undefined],
  ['an unparseable', 'not-an-address'],
])('rejects %s socket peer without reading the token store', (_label, remoteAddress) => {
  expect(authenticateInstance(peer(`Bearer ${TOKEN}`, remoteAddress), unreachable)).toBeNull();
  expect(unreachable).not.toHaveBeenCalled();
});

it.each([
  ['no matching row', undefined],
  ['another instance address', { user_id: 'owner', upstream_host: '172.30.0.18' }],
  ['a row without an address', { user_id: 'owner', upstream_host: null }],
])('rejects %s', (_label, row) => {
  expect(authenticateInstance(peer(`Bearer ${TOKEN}`, HOST), () => row)).toBeNull();
});

it('lets a token store failure escape instead of rejecting the token', () => {
  const failure = new Error('owned storage failure');

  expect(() =>
    authenticateInstance(peer(`Bearer ${TOKEN}`, HOST), () => {
      throw failure;
    }),
  ).toThrow(failure);
});

interface Context {
  readonly app: FastifyInstance;
  readonly database: DatabaseHandle;
  readonly lines: string[];
  readonly token: string;
  readonly get: (url: string, authorization?: string) => Promise<[number, unknown]>;
}
/** The real application over a running loopback instance, plus a probe route under the prefix. */
async function withInstance(
  run: (context: Context) => Promise<void>,
  upstreamMode: 'network' | 'published-loopback' = 'network',
): Promise<void> {
  await withApp(
    async (app, database, lines) => {
      const token = instanceToken();
      seedInstance(database, { userId: 'owner', token, host: '127.0.0.1' });
      app.get(PROBE, (request) => ({ userId: request.instanceUserId ?? null }));
      const get = async (url: string, authorization?: string): Promise<[number, unknown]> => {
        const response = await app.inject({
          method: 'GET',
          url,
          remoteAddress: '127.0.0.1',
          headers: authorization === undefined ? {} : { authorization },
        });
        return [response.statusCode, response.json()];
      };
      await run({ app, database, lines, token, get });
    },
    false,
    [],
    undefined,
    { upstreamMode },
  );
}

it('admits a running instance token from its own address and attaches its owner', async () => {
  await withInstance(async ({ get, token }) => {
    expect(await get(PROBE, `Bearer ${token}`)).toEqual([200, { userId: 'owner' }]);
    expect(await get(PROBE)).toEqual([401, UNAUTHORIZED]);
  });
});

it.each([
  '/_platform/instance-api/ragflo%77/owned-probe',
  '/_platfor%6d/instance-api/ragflow/owned-probe',
])('authenticates the decoded route of %s', async (url) => {
  await withInstance(async ({ get, token }) => {
    expect(await get(url)).toEqual([401, UNAUTHORIZED]);
    expect(await get(url, `Bearer ${token}`)).toEqual([200, { userId: 'owner' }]);
  });
});

it('authenticates an undeclared path under the prefix before the platform 404', async () => {
  await withInstance(async ({ get, token }) => {
    const url = '/_platform/instance-api/ragflow/undeclared?probe=1';

    expect(await get(url)).toEqual([401, UNAUTHORIZED]);
    expect((await get(url, `Bearer ${token}`))[0]).toBe(404);
  });
});

it('leaves paths outside the prefix to their own routes', async () => {
  await withInstance(async ({ get }) => {
    expect((await get('/healthz', 'Bearer malformed'))[0]).toBe(200);
    expect((await get('/_platform/instance-api/other'))[0]).toBe(404);
  });
});

it('rejects every token in published-loopback mode without reading the token store', async () => {
  await withInstance(async ({ get, token, database }) => {
    database.exec('DROP TABLE instances');

    expect(await get(PROBE, `Bearer ${token}`)).toEqual([401, UNAUTHORIZED]);
  }, 'published-loopback');
});

it('answers a token store failure with the fixed 500 and fixed log text', async () => {
  await withInstance(async ({ get, token, database, lines }) => {
    database.exec('DROP TABLE instances');

    const response = await get(PROBE, `Bearer ${token}`);

    expect(response).toEqual([
      500,
      { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
    ]);
    const output = JSON.stringify(response) + lines.join('');
    expect(output).toContain('RAGFlow proxy authentication storage failure');
    for (const leak of ['SQLITE', 'no such table', 'instances', token, instanceTokenHash(token)])
      expect(output.includes(leak)).toBe(false);
  });
});
