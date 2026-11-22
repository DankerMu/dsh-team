import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect, promisify } from 'node:util';
import { afterAll, expect, it } from 'vitest';
import {
  bForgottenScript,
  documentServerAddress,
  expectedAttack,
  forgottenPresent,
  forgottenRows,
  namespaceForgottenListScript,
  proxyControl,
  registeredKey,
  sessionFailure,
} from './office-forgotten-stack-fixture.ts';
import type { AttackRow } from './office-forgotten-stack-fixture.ts';
import { NODE, REGISTRY } from './office-isolation-stack-fixture.ts';
import { scrub, StackWorkbenchFailure } from './stack-browser-fixture.ts';

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

/** Managed overlays as instances get them (a JSON array): the stand-in's secret, another secret,
 * and an ONLYOFFICE row without one. */
const DIR = mkdtempSync(join(tmpdir(), 'dsh-team-forgotten-'));
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});
const overlay = (name: string, config: object) => {
  const path = join(DIR, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify([{ id: 'webserver' }, { id: 'dsh-sidebar-onlyoffice', config }]),
  );
  return path;
};
const OVERLAY = overlay('managed', { documentServerUrl: 'http://ds', jwtSecret: JWT_SECRET });
const WRONG = overlay('wrong', { documentServerUrl: 'http://ds', jwtSecret: hex() });
const NO_SECRET = overlay('none', { documentServerUrl: 'http://ds' });

/** B's real container script against `port`, the JWT read from `from`, the proxy healthcheck as
 * the positive control. */
const attack = (rows: readonly AttackRow[], port: number, from = OVERLAY) => {
  const control = { ...proxyControl('127.0.0.1'), port, host: '127.0.0.1' };
  return local(bForgottenScript(from), [JSON.stringify({ rows, kA: KA, control })], {});
};

type Mode = 'blocked' | 'open' | 'hang' | 'fence' | 'missing';
const json = (res: ServerResponse, status: number, body: object) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A Command Service stand-in. The proxy healthcheck answers `true` in every mode. `blocked` 403s
 * (the post-fix ACL); `fence` 403s with the plugin proxy's own body; `missing` 404s; `hang` never
 * answers; `open` answers as the unpatched Document Server: error 6 unless the body token is an
 * HS256 JWT under JWT_SECRET whose payload repeats the body's `c` and `key`, error 1 when
 * `getForgotten`/`deleteForgotten` name another key, else the forgotten `keys`, URL or deletion. */
function dsStub(mode: Mode, keys: readonly string[] = [KA]) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET' && path === '/forgotten-bytes') {
      res.writeHead(200);
      res.end(Buffer.from('forgotten-docx-bytes'));
      return;
    }
    if (req.method === 'GET' && path === '/sidebar/onlyoffice/ds/healthcheck') {
      res.writeHead(200);
      res.end('true');
      return;
    }
    if (mode === 'hang') return;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (mode !== 'open') {
        const status = mode === 'missing' ? 404 : 403;
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(mode === 'fence' ? 'dsh-sidebar-onlyoffice: cross-site request refused' : 'no');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const [, payload = ''] = String(body.token).split('.');
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8') || '{}',
      ) as Record<string, unknown>;
      if (!signedWithSecret(body.token) || claims.c !== body.c || claims.key !== body.key) {
        json(res, 200, { error: 6 });
        return;
      }
      const { port } = server.address() as AddressInfo;
      // The unpatched Document Server sets error 0 (NoError) on success for all three commands.
      if (body.c === 'getForgottenList') json(res, 200, { error: 0, keys });
      else if (body.key !== KA) json(res, 200, { error: 1 });
      else if (body.c === 'getForgotten')
        json(res, 200, {
          error: 0,
          key: KA,
          url: `http://127.0.0.1:${String(port)}/forgotten-bytes`,
        });
      else json(res, 200, { error: 0, key: KA });
    });
  });
  return server;
}

async function listening(server: ReturnType<typeof dsStub>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Runs `body` against a stand-in in `mode`, closing it afterwards. */
async function withStub(mode: Mode, body: (port: number) => Promise<void>, keys?: string[]) {
  const { port, close } = await listening(dsStub(mode, keys));
  try {
    await body(port);
  } finally {
    await close();
  }
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

type Rows = Record<'list' | 'get' | 'delete', Record<string, unknown>[]>;

it('refuses every row, learns no key, downloads nothing and deletes nothing against the post-fix ACL', async () => {
  await withStub('blocked', async (port) => {
    const rows = [
      row({ id: '80', path: '/command' }, port),
      row({ id: '80', path: '/coauthoring/CommandService.ashx' }, port),
      row({ id: '80', path: '/command', xff: true }, port),
      row({ id: 'proxy', path: '/sidebar/onlyoffice/ds/command' }, port),
    ];
    const observed = await attack(rows, port);
    expect(observed).toEqual(expectedAttack(rows));
    expect(JSON.stringify(observed)).not.toContain(KA);
  });
});

it('signs with the overlay JWT and records that B lists, downloads and deletes against the pre-fix server', async () => {
  await withStub('open', async (port) => {
    const observed = (await attack([row({}, port)], port)) as Rows;
    expect(observed.list[0]).toMatchObject({
      outcome: 'reached',
      error: 0,
      length: 1,
      listedKa: true,
    });
    const reached = { outcome: 'reached', error: 0, gotUrl: true };
    expect(observed.get[0]).toMatchObject({ ...reached, fetched: { status: 200, bytes: true } });
    expect(observed.delete[0]).toMatchObject({ outcome: 'reached', error: 0, deleted: true });
    expect(JSON.stringify(observed)).not.toContain(KA);
  });
});

it('records DS error 6 when B signs with a secret the Document Server does not hold', async () => {
  await withStub('open', async (port) => {
    const observed = (await attack([row({}, port)], port, WRONG)) as Rows;
    expect(observed.list[0]).toMatchObject({ outcome: 'reached', error: 6, listedKa: false });
    expect(observed.get[0]).toMatchObject({ error: 6, gotUrl: false });
  });
});

it('fails loudly when the overlay has no ONLYOFFICE JWT, and reads /managed/patch.yml by default', async () => {
  await withStub('open', async (port) => {
    await expect(attack([row({}, port)], port, NO_SECRET)).rejects.toThrow(
      'no jwtSecret in the managed overlay',
    );
  });
  const delivered = bForgottenScript();
  expect(delivered).toContain(`readFileSync("/managed/patch.yml", 'utf8')`);
  expect(delivered).not.toContain('js-yaml');
  expect(delivered.toLowerCase()).not.toContain('authorization');
});

it('marks a plugin-fence 403 so it fails the expectation, with the proxy healthcheck answering', async () => {
  await withStub('fence', async (port) => {
    const rows = [row({ id: 'proxy', path: '/sidebar/onlyoffice/ds/command' }, port)];
    const observed = (await attack(rows, port)) as Rows & { control: unknown };
    expect(observed.control).toEqual({ status: 200, body: 'true' });
    expect(observed.list[0]).toMatchObject({ outcome: 'refused', fence: true });
    expect(observed).not.toEqual(expectedAttack(rows));
  });
});

it('classifies a 404 as status-404 and a closed port as refused-conn, neither meeting the expectation', async () => {
  await withStub('missing', async (port) => {
    const rows = [row({}, port)];
    const observed = (await attack(rows, port)) as Rows;
    expect(observed.list[0]).toMatchObject({ outcome: 'status-404' });
    expect(observed).not.toEqual(expectedAttack(rows));
  });
  const closed = await listening(dsStub('blocked'));
  await closed.close();
  const rows = [row({}, closed.port)];
  const observed = (await attack(rows, closed.port)) as Rows;
  expect(observed.list[0]).toMatchObject({ outcome: 'refused-conn' });
  expect(observed).not.toEqual(expectedAttack(rows));
});

it('classifies an accepting but silent Document Server as a timeout, not a refusal', async () => {
  await withStub('hang', async (port) => {
    const observed = (await attack([row({ id: '8000' }, port)], port)) as Rows;
    expect(observed.list[0]?.outcome).toBe('timeout');
  });
}, 20_000);

it('lists over loopback with a JWT from stdin, reports error/listed/contains/length/shape, never keys', async () => {
  const { port, close } = await listening(dsStub('open'));
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
  // Only the key's digest is embedded: a failed docker exec quoting the script cannot leak it.
  expect(delivered).not.toContain(KA);
});

it('finds A key inside a <key>/output entry by digest, without listing it as a bare key', async () => {
  await withStub(
    'open',
    async (port) => {
      const observed = await local(namespaceForgottenListScript(KA, port), [], {}, JWT_SECRET);
      expect(observed).toMatchObject({ listed: false, contains: true, length: 1 });
      expect(observed.shape).toEqual({ type: 'string', slash: true, dotExt: true });
    },
    [`${KA}/output.docx`],
  );
});

it('treats a <key>/output entry as present via contains, and a 403 or empty list as absent', () => {
  expect(forgottenPresent({ status: 200, listed: true, contains: false })).toBe(true);
  expect(forgottenPresent({ status: 200, listed: false, contains: true })).toBe(true);
  expect(forgottenPresent({ status: 200, listed: false, contains: false })).toBe(false);
  expect(forgottenPresent({ status: 403, listed: true, contains: true })).toBe(false);
});

it('attributes a failed reopen to the alert it showed and the console errors, with A key redacted', () => {
  const blocked = new Error('locator.click: Timeout 60000ms exceeded');
  const session = {
    ...{ screenshots: [], pageErrors: [], failedRequests: [], externalRequests: [] },
    ...{ consoleErrors: [`socket ${KA} closed`, 'ServiceWorker 403'], requests: 1, websockets: 1 },
  };
  const failure = new StackWorkbenchFailure(blocked, session, 'office forgotten recover');
  const alert = { shown: true, value: '-104', text: 'opened from the backup copy' } as const;

  const error = sessionFailure('recover', failure, { alert }, KA);

  expect(error.message).toContain('Timeout 60000ms exceeded');
  expect(error.message).toContain('"value":"-104","text":"opened from the backup copy"');
  expect(error.message).toContain(
    '"consoleErrors":["socket <redacted> closed","ServiceWorker 403"]',
  );
  expect(error.message).not.toContain(KA);
  expect(error.cause).toBeUndefined();
  expect(sessionFailure('recover', blocked, { alert: 'not reached' }, KA).message).toContain(
    'scene={"alert":"not reached","consoleErrors":[],"failedRequests":[]}',
  );
});

/** Everything vitest could print for `error`: the inspected cause chain and own properties, and JSON. */
const printed = (error: Error) => `${inspect(error, { depth: 20 })}\n${JSON.stringify(error)}`;

it.each([
  ['recover', KA],
  ['edit', null],
] as const)(
  'leaves a %s failure without cause and with no trace of A key anywhere, known or not',
  (label, known) => {
    const blocked = new Error(`locator.click: Timeout on /doc/${KA}/c/?EIO=4`, {
      cause: new Error(`frame /doc/${KA}/c/`),
    });
    const session = {
      ...{ screenshots: [], pageErrors: [], externalRequests: [], requests: 1, websockets: 1 },
      ...{ consoleErrors: [`socket /doc/${KA}/c/ closed`], failedRequests: [`GET /doc/${KA}/c/`] },
    };
    const failure = new StackWorkbenchFailure(blocked, session, `office forgotten ${label}`);

    const error = sessionFailure(label, failure, { keyRead: known !== null }, known);

    expect(error.cause).toBeUndefined();
    expect(printed(error)).not.toContain(KA);
    expect(error.message).toContain('Timeout on /doc/<redacted>/c/ <- frame /doc/<redacted>/c/;');
    expect(error.message).toContain('"failedRequests":["GET /doc/<redacted>/c/"]');
  },
);

it('scrubs each part of a failure that never passed through a workbench session', () => {
  const blocked = new Error(`page.goto: ws://127.0.0.1:1/doc/${KA}/c/?EIO=4`, {
    cause: new Error('frame s3cret-of-a'),
  });

  const error = sessionFailure(
    'edit',
    blocked,
    { note: `copy /doc/${KA}/c/?sid=1` },
    's3cret-of-a',
  );

  expect(error.message).toBe(
    'Office forgotten edit failed: page.goto: ws://127.0.0.1:1/doc/<redacted>/c/ <- frame <redacted>; scene={"note":"copy /doc/<redacted>/c/","consoleErrors":[],"failedRequests":[]}',
  );
});

it('scrubs A key, and any document key, from the reopen alert text', () => {
  expect(scrub(`restored ${KA} copy`, [KA])).toBe('restored <redacted> copy');
  expect(scrub(`restored ${'b2'.repeat(32)} copy`)).toBe('restored <redacted> copy');
});

/** A's registry query answering `replies` in turn; each call's argv goes to `calls`. */
const registryLane = (calls: (readonly string[])[], ...replies: (() => Promise<string>)[]) => ({
  exec: (args: readonly string[]) => {
    calls.push(args);
    return (replies.shift() ?? (() => Promise.reject(new Error('no reply'))))();
  },
});
const FORGOTTEN_ARGV = ['python3', '-I', '-c', REGISTRY, '/data/work/忘记恢复.docx'];

it("polls A's registry until it names the DOCX and returns the first of its keys", async () => {
  const calls: (readonly string[])[] = [];
  const replies = [() => Promise.resolve('[]'), () => Promise.resolve(JSON.stringify([KA, hex()]))];

  const key = await registeredKey(registryLane(calls, ...replies));

  expect(key).toBe(KA);
  expect(calls.map((args) => args.filter((_, i) => i !== 3))).toEqual([
    FORGOTTEN_ARGV,
    FORGOTTEN_ARGV,
  ]);
});

it('fails with the registry query rejection instead of polling it as no key', async () => {
  const calls: (readonly string[])[] = [];
  const refused = () => Promise.reject(new Error('registry format mismatch: version'));
  // A caller that counted the failure as no key would poll again and return KA.
  const lane = registryLane(calls, refused, () => Promise.resolve(JSON.stringify([KA])));

  const key = registeredKey(lane);

  await expect(key).rejects.toThrow(new Error('registry format mismatch: version'));
  expect(calls).toHaveLength(1);
});
