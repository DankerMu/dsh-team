import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { expect, it } from 'vitest';
import {
  bForgottenScript,
  documentServerAddress,
  expectedAttack,
  FORGOTTEN_ATTACK_JS,
  forgottenPresent,
  forgottenRows,
  namespaceForgottenListScript,
} from './office-forgotten-stack-fixture.ts';
import type { AttackRow } from './office-forgotten-stack-fixture.ts';
import { NODE } from './office-isolation-stack-fixture.ts';

const KA = 'a1'.repeat(32);
const [nodeBinary = 'node', ...nodeFlags] = NODE;
const hex = () => randomBytes(32).toString('hex');
/** The stand-in Document Server's inbox secret; any other signer gets error 6, as DS answers. */
const JWT_SECRET = hex();

/** Runs a container-shaped ESM script under the local node, `input` on stdin as `docker exec -i`
 * delivers it; stdout is parsed as the observation. */
const local = async (source: string, argv: string[], env: Record<string, string>, input = '') => {
  const options = { env: { ...process.env, ...env } };
  const pending = promisify(execFile)(nodeBinary, [...nodeFlags, source, ...argv], options);
  pending.child.stdin?.end(input);
  const { stdout } = await pending;
  return JSON.parse(stdout) as Record<string, unknown>;
};

/** Whether a body `token` is an HS256 JWT signed with JWT_SECRET. */
const signedWithSecret = (token: unknown) => {
  const [header = '', payload = '', signature] = String(token).split('.');
  const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`);
  return signature === expected.digest('base64url');
};

/** The attack body as the container runs it, but with the JWT from the environment and `rows`/`kA`
 * baked in, so the pure HTTP and classification logic can run against a local Document Server stub. */
const probe = (rows: readonly AttackRow[], kA: string) => `import { request } from 'node:http';
import { createHmac } from 'node:crypto';
const jwtSecret = process.env.DOCUMENT_SERVER_JWT_SECRET;
const rows = ${JSON.stringify(rows)};
const kA = ${JSON.stringify(kA)};
const observed = {};
${FORGOTTEN_ATTACK_JS}
process.stdout.write(JSON.stringify(observed));`;

/** A Command Service stand-in: `blocked` 403s every path (the post-fix ACL); `open` answers the
 * forgotten commands as the unpatched Document Server would; `hang` accepts but never replies;
 * `bad-token` reaches the handler but rejects every command with error 6. */
function dsStub(mode: 'blocked' | 'open' | 'hang' | 'bad-token') {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET' && path === '/forgotten-bytes') {
      res.writeHead(200);
      res.end(Buffer.from('forgotten-docx-bytes'));
      return;
    }
    if (mode === 'hang') return;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (mode === 'blocked') {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      if (mode === 'bad-token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 6 }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        c?: string;
        token?: unknown;
      };
      const { port } = server.address() as AddressInfo;
      if (!signedWithSecret(body.token)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 6 }));
        return;
      }
      // The unpatched Document Server sets error 0 (NoError) on success for all three commands.
      const reply =
        body.c === 'getForgottenList'
          ? { error: 0, keys: [KA] }
          : body.c === 'getForgotten'
            ? { error: 0, key: KA, url: `http://127.0.0.1:${String(port)}/forgotten-bytes` }
            : body.c === 'deleteForgotten'
              ? { error: 0, key: KA }
              : { error: 1 };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  return server;
}

async function listening(server: ReturnType<typeof dsStub>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

const row = (overrides: Partial<AttackRow>, port: number): AttackRow => ({
  id: '80',
  address: '127.0.0.1',
  port,
  host: '127.0.0.1',
  path: '/command',
  xff: false,
  ...overrides,
});

it('computes the +4 Document Server address two octets above the instance on its /28 bridge', () => {
  expect(documentServerAddress('10.1.2.18')).toBe('10.1.2.20');
  expect(() => documentServerAddress('10.1.2.300')).toThrow('malformed');
});

it('covers both commands, case, trailing slash, the version prefix and a forged XFF on :80 and the proxy, only /command on :8000', () => {
  const rows = forgottenRows('10.0.0.2', '10.0.0.4');

  const ids = rows.map((r) => r.id);
  expect(ids.filter((id) => id === '8000')).toEqual(['8000']);
  expect(rows.find((r) => r.id === '8000')).toEqual({
    id: '8000',
    address: '10.0.0.4',
    port: 8000,
    host: '10.0.0.4',
    path: '/command',
    xff: false,
  });
  const proxy = rows.filter((r) => r.id === 'proxy');
  expect(proxy.every((r) => r.path.startsWith('/sidebar/onlyoffice/ds/'))).toBe(true);
  expect(proxy.every((r) => r.address === '10.0.0.2' && r.host === '127.0.0.1:3080')).toBe(true);
  const paths80 = rows.filter((r) => r.id === '80').map((r) => r.path);
  expect(paths80).toContain('/coauthoring/CommandService.ashx');
  for (const path of ['command', 'command%3F', 'command%23', 'coauthoring/CommandService.ashx%3F'])
    expect(paths80).toContain(`/9.4.0-1/${path}`);
  expect(proxy.map((r) => r.path)).toContain('/sidebar/onlyoffice/ds/9.4.0-1/command%23');
  expect(rows.filter((r) => r.xff).map((r) => `${r.id} ${r.path}`)).toEqual([
    '80 /command',
    'proxy /sidebar/onlyoffice/ds/command',
  ]);
});

it('refuses every row, learns no key, downloads nothing and deletes nothing against the post-fix ACL', async () => {
  const stub = dsStub('blocked');
  const { port, close } = await listening(stub);
  const rows = [
    row({ id: '80', path: '/command' }, port),
    row({ id: '80', path: '/coauthoring/CommandService.ashx' }, port),
    row({ id: '80', path: '/command', xff: true }, port),
    row({ id: 'proxy', path: '/sidebar/onlyoffice/ds/command' }, port),
  ];
  try {
    const observed = await local(probe(rows, KA), [], { DOCUMENT_SERVER_JWT_SECRET: JWT_SECRET });
    expect(observed).toEqual(expectedAttack(rows));
    expect(JSON.stringify(observed)).not.toContain(KA);
  } finally {
    await close();
  }
});

it('records that B would list A key, download content and delete the copy against the pre-fix server', async () => {
  const stub = dsStub('open');
  const { port, close } = await listening(stub);
  const rows = [row({ id: '80', path: '/command' }, port)];
  try {
    const observed = (await local(probe(rows, KA), [], {
      DOCUMENT_SERVER_JWT_SECRET: JWT_SECRET,
    })) as { list: unknown[]; get: unknown[]; delete: unknown[] };
    expect(observed.list[0]).toMatchObject({
      outcome: 'reached',
      error: 0,
      length: 1,
      listedKa: true,
    });
    expect(observed.get[0]).toMatchObject({
      outcome: 'reached',
      error: 0,
      gotUrl: true,
      fetched: { status: 200, bytes: true },
    });
    expect(observed.delete[0]).toMatchObject({ outcome: 'reached', error: 0, deleted: true });
    expect(JSON.stringify(observed)).not.toContain(KA);
  } finally {
    await close();
  }
});

it('records DS error 6 (bad token) on a reached-but-rejected row, distinct from a silent list', async () => {
  const stub = dsStub('bad-token');
  const { port, close } = await listening(stub);
  const rows = [row({ id: '80', path: '/command' }, port)];
  try {
    const observed = (await local(probe(rows, KA), [], {
      DOCUMENT_SERVER_JWT_SECRET: JWT_SECRET,
    })) as { list: { outcome: string; error: number | null; listedKa: boolean }[] };
    expect(observed.list[0]).toMatchObject({ outcome: 'reached', error: 6, listedKa: false });
  } finally {
    await close();
  }
});

it('classifies an accepting but silent Document Server as a timeout, not a refusal', async () => {
  const stub = dsStub('hang');
  const { port, close } = await listening(stub);
  const rows = [row({ id: '8000', port, path: '/command' }, port)];
  try {
    const observed = (await local(probe(rows, KA), [], {
      DOCUMENT_SERVER_JWT_SECRET: JWT_SECRET,
    })) as { list: { outcome: string }[] };
    expect(observed.list[0]?.outcome).toBe('timeout');
  } finally {
    await close();
  }
}, 20_000);

it('lists over loopback with a JWT from stdin, reports error/listed/contains/length/shape, never keys', async () => {
  const stub = dsStub('open');
  const { port, close } = await listening(stub);
  try {
    const script = namespaceForgottenListScript(KA, port);
    // A decoy secret in the environment must not be used: only stdin signs.
    const observed = await local(script, [], { DOCUMENT_SERVER_JWT_SECRET: hex() }, JWT_SECRET);
    expect(observed).toEqual({
      status: 200,
      error: 0,
      listed: true,
      contains: true,
      length: 1,
      shape: { type: 'string', slash: false, dotExt: false },
    });
    expect(JSON.stringify(observed)).not.toContain(KA);
    expect(forgottenPresent(observed)).toBe(true);
    const forged = await local(script, [], { DOCUMENT_SERVER_JWT_SECRET: JWT_SECRET }, hex());
    expect(forged).toMatchObject({ status: 200, error: 6, listed: false, length: 0 });
    expect(forgottenPresent(forged)).toBe(false);
    const absent = namespaceForgottenListScript('f0'.repeat(32), port);
    const miss = await local(absent, [], {}, JWT_SECRET);
    expect(miss).toMatchObject({ status: 200, error: 0, listed: false, contains: false });
    expect(forgottenPresent(miss)).toBe(false);
  } finally {
    await close();
  }
  const delivered = namespaceForgottenListScript(KA);
  expect(delivered).toContain('request({ host: "127.0.0.1", port: 80, method');
  expect(delivered).toContain("const headers = { host: '127.0.0.1' };");
  expect(delivered).toContain("const jwtSecret = readFileSync(0, 'utf8');");
  expect(delivered).not.toContain('DOCUMENT_SERVER_JWT_SECRET');
});

it('treats a <key>/output entry as present via contains, and a 403 or empty list as absent', () => {
  expect(forgottenPresent({ status: 200, listed: true, contains: false })).toBe(true);
  expect(forgottenPresent({ status: 200, listed: false, contains: true })).toBe(true);
  expect(forgottenPresent({ status: 200, listed: false, contains: false })).toBe(false);
  expect(forgottenPresent({ status: 403, listed: true, contains: true })).toBe(false);
});

it("reads B's JWT from the managed overlay, takes the key from argv and never logs authorization", () => {
  const script = bForgottenScript();

  for (const part of [
    "const overlay = JSON.parse(readFileSync('/managed/patch.yml', 'utf8'));",
    "row.id === 'dsh-sidebar-onlyoffice'",
    'const jwtSecret = onlyoffice?.config?.jwtSecret;',
    "if (typeof jwtSecret !== 'string' || jwtSecret === '') throw new Error(",
    'const { rows, kA } = JSON.parse(process.argv[1]);',
    "await attempt(row, { c: 'getForgottenList'",
    "await attempt(row, { c: 'getForgotten', key: kA",
    "await attempt(row, { c: 'deleteForgotten', key: kA",
    "headers['x-forwarded-for'] = '127.0.0.1';",
  ])
    expect(script).toContain(part);
  // No js-yaml require: the overlay is JSON, so a read bug cannot silently yield an empty secret.
  expect(script).not.toContain('js-yaml');
  expect(script.toLowerCase()).not.toContain('authorization');
  expect(script).not.toContain(KA);
});
