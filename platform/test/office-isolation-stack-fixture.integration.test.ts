import { execFile } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { expect, it } from 'vitest';
import { DOCUMENT_SERVER } from './office-hints-stack-fixture.ts';
import {
  aGuessScript,
  aReadScript,
  aSetupScript,
  aSignScript,
  bProbeScript,
  EXPECTED_ATTACK,
  EXPECTED_INFO,
  EXPECTED_ISOLATION,
  guessedKeyInfo,
  NODE,
  officeIsolationLine,
  officeIsolationScenario,
  platformAttackScript,
  platformInfoScript,
  redactSecrets,
} from './office-isolation-stack-fixture.ts';
import { JWT_JS } from './onlyoffice-probe-script.ts';
import type { OfficeIsolationLane } from './office-isolation-stack-fixture.ts';
import { record } from './docker-cleanup.ts';

const A = '10.0.0.2';
const B = '10.0.1.2';
const SECRETS = {
  ...{ k1: 'a1'.repeat(32), kB: 'b1'.repeat(32), k0: 'c0'.repeat(32), kGuessed: 'd1'.repeat(32) },
  ...{ t: 'tok-t', tPublic: 'tok-p', tGuessed: 'tok-g', tB: 'tok-b' },
};

it("writes both files, requests A's config with a loopback Host and waits for k1 without k0 (c1)", () => {
  const script = aSetupScript(A);

  for (const part of [
    'const secret = process.env.DSH_TEAM_ONLYOFFICE_FILE_SECRET;',
    'writeFileSync("/data/work/隔离来源.docx"',
    'const file = "/data/work/隔离目标.docx";',
    'request({ host: "10.0.0.2", port: 3080',
    "const headers = { host: '127.0.0.1:3080' };",
    "'/sidebar/onlyoffice/config?sessionId=t&path='",
    "'/data/home/plugins/dsh-sidebar-onlyoffice/registry.json'",
    'while ((!seen.k1 || seen.k0) && Date.now() < deadline)',
    'observed.k1 = k1;',
  ])
    expect(script).toContain(part);
  expect(script).not.toContain('process.argv');
});

it('probes A then B over TCP and signs T_B over the claims in argv[1] (c2)', () => {
  const script = bProbeScript(A, B);

  for (const part of [
    'observed.connect = { a: await probe("10.0.0.2"), b: await probe("10.0.1.2") };',
    "setTimeout(() => { socket.destroy(); resolve('blocked'); }, 3000)",
    "socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected'); });",
    'request({ host: "10.0.1.2", port: 3080',
    'const tB = mint(JSON.parse(process.argv[1]), secret);',
    "'/sidebar/onlyoffice/file?token=' + encodeURIComponent(tB)",
    'observed.registry = seen;',
    'observed.kB = k1;',
  ])
    expect(script).toContain(part);
  expect(script).not.toContain('request({ host: "10.0.0.2"');
});

it("signs T, the public-constant and guessed-key tokens over argv[1] and reads the source with T (c1')", () => {
  const script = aSignScript(A);

  for (const part of [
    'const claims = JSON.parse(process.argv[1]);',
    'const guessed = process.argv[2];',
    'const info = statSync(file);',
    'request({ host: "10.0.0.2", port: 3080',
    "const headers = { host: '127.0.0.1:3080' };",
    'const t = mint(claims, secret);',
    'observed.tPublic = mint(claims, "dsh-sidebar-onlyoffice/file-token/v1");',
    'observed.tGuessed = mint(claims, guessed);',
    "observed.kGuessed = createHmac('sha256', guessed).update(input).digest('hex');",
    'served.body.equals(readFileSync("/data/work/隔离来源.docx"))',
  ])
    expect(script).toContain(part);
});

it("sends every (c3) request to A's address with A's Host and a body-token JWT from the platform env", () => {
  const script = platformAttackScript(A, { k1: 'K1', t: 'T' });

  for (const part of [
    'const inputs = {"k1":"K1","t":"T"};',
    'const jwtSecret = process.env.DOCUMENT_SERVER_JWT_SECRET;',
    'request({ host: "10.0.0.2", port: 3080',
    "const headers = { host: '10.0.0.2:3080' };",
    "const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');",
    "b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 })",
    "'http://10.0.0.2:3080/sidebar/onlyoffice/file?token=' + encodeURIComponent(inputs.t)",
    "'/sidebar/onlyoffice/callback', { key, status: 2, url, ...(signed ? { token: jwt() } : {}) }",
    'observed.file = { public: await forged(inputs.tPublic), guessed: await forged(inputs.tGuessed), b: await forged(inputs.tB), t: await source(inputs.t) };',
    'observed.callback = { k0: await callback(inputs.k0, true), hmacGuessed: await callback(inputs.kGuessed, true), kB: await callback(inputs.kB, true), noJwtK1: await callback(inputs.k1, false), jwtK1: await callback(inputs.k1, true) };',
    `observed.config = json(await exchange('GET', '/sidebar/onlyoffice/config?sessionId=t&path=' + encodeURIComponent(file) + '&cwd=' + encodeURIComponent("/data/work")));`,
    "matches: createHash('sha256').update(r.body).digest('hex') === inputs.sourceSha };",
  ])
    expect(script).toContain(part);
  expect(script.toLowerCase()).not.toContain('authorization');
  expect(aReadScript()).toContain(
    `observed.target = readFileSync(file).equals(readFileSync("/data/work/隔离来源.docx")) ? 'saved' : 'unchanged';`,
  );
});

it('expects A to register only k1, B to reach only itself with a valid B token and T to read A', () => {
  expect(EXPECTED_ISOLATION).toEqual({
    a: { config: { status: 200, signed: true }, registry: { k0: false, k1: true } },
    b: {
      connect: { a: 'blocked', b: 'connected' },
      config: { status: 200, signed: true },
      registry: { k0: false, k1: true },
      file: { status: 404, body: 'file not found' },
    },
    sign: { fileWithT: { status: 200, matches: true } },
  });
});

it('expects the privileged position to be refused everything but T and the JWT-signed k1 save', () => {
  const badSignature = { status: 403, body: 'invalid token: bad-signature' };
  const unknownKey = { status: 200, error: 1 };
  expect(EXPECTED_ATTACK).toEqual({
    config: {
      status: 403,
      body: { ok: false, error: { code: 'forbidden', message: 'forbidden' } },
    },
    file: {
      public: badSignature,
      guessed: badSignature,
      b: badSignature,
      t: { status: 200, matches: true },
    },
    callback: {
      ...{ k0: unknownKey, hmacGuessed: unknownKey, kB: unknownKey },
      ...{ noJwtK1: { status: 403, error: 4 }, jwtK1: { status: 200, error: 0 } },
    },
    target: 'saved',
  });
});

it('redacts k1, k1_B and T_B from an error text', () => {
  const [k1, kB, tB] = ['k1-value', 'kb-value', 'tb.value'];
  const redacted = redactSecrets(`${k1} ${kB} ${tB} ${k1}`, [k1, kB, tB, undefined, '']);

  expect(redacted).toBe('<redacted> <redacted> <redacted> <redacted>');
});

it('fails the evidence line when the scenario left none', () => {
  expect(() => officeIsolationLine(undefined)).toThrow('Office isolation evidence missing');
});

const DIFFER: Record<string, object> = {
  sign: { fileWithT: { status: 403, matches: false } },
  attack: { callback: { ...EXPECTED_ATTACK.callback, jwtK1: { status: 200, error: 1 } } },
};

/** A, B and the platform answering as the stack does; `failing` rejects that step as `output()` would,
 * argv included, or answers it with every secret but `DIFFER`ent, or with a secret as non-JSON `text`. */
function fakeLane(events: string[], failing = '', how = 'reject'): OfficeIsolationLane {
  const { k1, kB, tB, ...signed } = SECRETS;
  const { config, file, callback } = EXPECTED_ATTACK;
  const answer = (label: string, args: readonly string[], reply: object) => {
    events.push(label);
    if (label !== failing) return Promise.resolve(JSON.stringify(reply));
    if (how === 'text') return Promise.resolve(`${SECRETS.k1} is no JSON`);
    if (how === 'differ')
      return Promise.resolve(JSON.stringify({ ...reply, ...SECRETS, ...DIFFER[label] }));
    return Promise.reject(new Error(`docker ${args.join(' ')} failed (null): ETIMEDOUT`));
  };
  const replies = [
    ['observed.k1 = k1', 'setup', { ...EXPECTED_ISOLATION.a, k1 }],
    ['fileWithT', 'sign', { ...EXPECTED_ISOLATION.sign, ...signed, sourceSha: 'sha-of-source' }],
    ['observed.target', 'read', { target: 'saved' }],
  ] as const;
  const address = { IPAddress: A };
  const parsed = async (reply: Promise<string>) => record(JSON.parse(await reply));
  return {
    ...{ session: {} as never, instance: 'dsh-team-u-a' },
    run: (args) =>
      args[0] === 'container'
        ? Promise.resolve(JSON.stringify({ [(args[4] ?? '').replace('-u-', '-net-')]: address }))
        : answer('b', args, { ...EXPECTED_ISOLATION.b, kB, tB }),
    exec: (args) => {
      const [, label, reply] = replies.find(([part]) => args[3]?.includes(part)) ?? [
        '',
        'clean',
        [],
      ];
      return answer(label, args, label === 'clean' ? [false, false] : reply);
    },
    platformRead: (script) => parsed(answer('attack', [script], { config, file, callback })),
    provider: () => parsed(answer('provider', [], { requests: 0, searches: 0, delegations: 0 })),
    secondEmployee: () => Promise.resolve('dsh-team-u-b'),
    retire: () => Promise.resolve(void events.push('retire')),
  };
}

it('signs T after B retires, attacks from the platform, reads the target back, then counts the provider', async () => {
  const events: string[] = [];
  const evidence = officeIsolationLine(await officeIsolationScenario(fakeLane(events)));

  expect(evidence).toEqual({ ...EXPECTED_ISOLATION, attack: EXPECTED_ATTACK });
  expect(events.join(' ')).toBe('provider setup b retire sign attack read provider clean');
  for (const secret of Object.values(SECRETS))
    expect(JSON.stringify(evidence)).not.toContain(secret);
});

it.each([
  ...[
    ['b', 'reject', 'ETIMEDOUT'],
    ['sign', 'reject', 'ETIMEDOUT'],
    ['attack', 'reject', 'ETIMEDOUT'],
  ],
  ...[
    ['sign', 'differ', 'differs'],
    ['attack', 'differ', 'differs'],
    ['sign', 'text', 'output is not JSON'],
  ],
])(
  'redacts every key and token from the %s step answering %s and still retires B',
  async (step, how, reason) => {
    const events: string[] = [];
    const error: unknown = await officeIsolationScenario(fakeLane(events, step, how)).catch(
      (caught: unknown) => caught,
    );

    if (!(error instanceof Error)) throw new Error('Office isolation scenario did not fail');
    expect(error.message).toContain(reason);
    for (const secret of Object.values(SECRETS)) expect(error.message).not.toContain(secret);
    expect(error.message).not.toMatch(/[0-9a-f]{64}/);
    expect(error.message).not.toContain(SECRETS.k1.slice(0, 10));
    expect(error.cause).toBeUndefined();
    expect(events.filter((event) => event === 'retire')).toHaveLength(1);
  },
);

const [OPEN, UNKNOWN] = [
  { status: 200, error: 0, users: ['dsh'] },
  { status: 200, error: 1 },
];

it("expects A's and B's keys to name their one editor, k0 and the guessed key no session", () => {
  expect(EXPECTED_INFO).toEqual({ k1: OPEN, kB: OPEN, k0: UNKNOWN, kGuessed: UNKNOWN });
});

const [nodeBinary = 'node', ...nodeFlags] = NODE;
/** The script under the local `node` as the containers run it; stdout parsed as JSON. */
const local = async (script: string, argv: string[], env: Record<string, string>) => {
  const options = { env: { ...process.env, ...env } };
  const { stdout } = await promisify(execFile)(
    nodeBinary,
    [...nodeFlags, script, ...argv],
    options,
  );
  return JSON.parse(stdout) as unknown;
};
const hex = () => randomBytes(32).toString('hex');

it('signs a JWT whose payload is only exp without claims, and the claims before exp with them', async () => {
  const signer = `import { createHmac } from 'node:crypto';
const jwtSecret = 'jwt-secret';
${JWT_JS}
process.stdout.write(JSON.stringify([jwt(), jwt({ c: 'info', key: 'K' })]));`;
  const tokens = (await local(signer, [], {})) as string[];
  const now = Math.floor(Date.now() / 1000);
  const payloads = tokens.map((token) => {
    const [header = '', payload = '', signature] = token.split('.');
    const signed = createHmac('sha256', 'jwt-secret').update(`${header}.${payload}`);
    expect(signature).toBe(signed.digest('base64url'));
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, number>;
  });
  expect(payloads.map((payload) => Object.keys(payload))).toEqual([['exp'], ['c', 'key', 'exp']]);
  for (const { exp = 0 } of payloads) expect(Math.abs(exp - now - 600)).toBeLessThanOrEqual(5);
  expect(payloads[1]).toMatchObject({ c: 'info', key: 'K' });
});

it("recomputes A's k1, k0 and the guessed-secret HMAC over the file's key input", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-office-guess-'));
  const file = join(dir, '编辑写回.docx');
  const [secret, guessed] = [hex(), hex()];
  try {
    writeFileSync(file, 'dsh-team office guessed key');
    const env = { DSH_TEAM_ONLYOFFICE_FILE_SECRET: secret };
    const observed = await local(aGuessScript(file), [guessed], env);
    const { size, mtimeMs } = statSync(file);
    const input = [hostname(), file, String(size), String(Math.round(mtimeMs))].join('\0');
    const hmac = (key: string) => createHmac('sha256', key).update(input).digest('hex');
    const k0 = createHash('sha256').update(input).digest('hex');
    expect(observed).toEqual({ k1: hmac(secret), k0, kGuessed: hmac(guessed) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const JWT_SECRET = hex();
const decoded = (part = '') =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

/** The Command Service as 51-e reads it: only `POST /command`; a body token signed with JWT_SECRET
 * whose `c` and `key` are the body's, else error 6; `open` keys answer their editor, others 1. */
async function commandStub(open: readonly string[]) {
  const seen: string[] = [];
  const answer = (host: string, text: string) => {
    const body = JSON.parse(text) as Record<string, unknown>;
    const [header = '', payload = '', signature] = String(body.token).split('.');
    const signed = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`);
    const claims = decoded(payload);
    const typed = isDeepStrictEqual(decoded(header), { alg: 'HS256', typ: 'JWT' });
    const valid = typed && signature === signed.digest('base64url');
    const matches = valid && claims.c === body.c && claims.key === body.key;
    seen.push(`${host} ${String(body.c)} ${String(matches)}`);
    const key = String(body.key);
    if (!matches) return { key, error: 6 };
    return open.includes(key) ? { key, error: 0, users: ['dsh'] } : { key, error: 1 };
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const command = req.method === 'POST' && req.url === '/command';
      const text = Buffer.concat(chunks).toString('utf8');
      const reply = command ? answer(String(req.headers.host), text) : {};
      res.writeHead(command ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { port, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

const INFO_KEYS = { k1: SECRETS.k1, kB: SECRETS.kB, k0: SECRETS.k0, kGuessed: SECRETS.kGuessed };

it('posts info for each key to the Command Service with a body-token JWT and keeps no key', async () => {
  const stub = await commandStub([SECRETS.k1, SECRETS.kB]);
  try {
    const script = platformInfoScript('127.0.0.1', INFO_KEYS, stub.port);
    const observed = await local(script, [], { DOCUMENT_SERVER_JWT_SECRET: JWT_SECRET });
    expect(observed).toEqual(EXPECTED_INFO);
    expect(stub.seen).toEqual(Array(4).fill('127.0.0.1 info true'));
    for (const key of Object.values(INFO_KEYS)) expect(JSON.stringify(observed)).not.toContain(key);
    const forged = await local(script, [], { DOCUMENT_SERVER_JWT_SECRET: hex() });
    const refused = { status: 200, error: 6 };
    expect(forged).toEqual({ k1: refused, kB: refused, k0: refused, kGuessed: refused });
  } finally {
    await stub.close();
  }
  const delivered = platformInfoScript(DOCUMENT_SERVER, INFO_KEYS);
  expect(delivered).toContain('request({ host: "dsh-team-documentserver", port: 80, method');
  expect(delivered).toContain("const headers = { host: 'dsh-team-documentserver' };");
  expect(delivered).toContain('const jwtSecret = process.env.DOCUMENT_SERVER_JWT_SECRET;');
});

const FILE = '/data/work/编辑写回.docx';
const OTHER_K1 = 'e1'.repeat(32);
const DIFFERS: Record<string, object> = {
  A: { k1: OTHER_K1, k0: SECRETS.k0, kGuessed: SECRETS.kGuessed },
  platform: { ...EXPECTED_INFO, kGuessed: { ...OPEN, key: SECRETS.kGuessed } },
};

/** A's exec and the platform answering as the stack does; `failing` rejects quoting argv, answers
 * `DIFFERS`, or answers a key as non-JSON text. `seen` gets each step's label and argv. */
function guessLane(seen: string[][], failing = '', how = 'reject') {
  const answer = (label: string, args: readonly string[], reply: object) => {
    seen.push([label, ...args]);
    if (label !== failing) return Promise.resolve(JSON.stringify(reply));
    if (how === 'text') return Promise.resolve(`${SECRETS.k1} is no JSON`);
    if (how === 'differ') return Promise.resolve(JSON.stringify(DIFFERS[label]));
    return Promise.reject(new Error(`docker ${args.join(' ')} failed (null): ETIMEDOUT`));
  };
  const own = { k1: SECRETS.k1, k0: SECRETS.k0, kGuessed: SECRETS.kGuessed };
  return {
    exec: (args: readonly string[]) => answer('A', args, own),
    platformRead: async (script: string) =>
      record(JSON.parse(await answer('platform', [script], EXPECTED_INFO))),
  };
}

it("recomputes k1 in A, then asks about A's, B's, k0 and the guessed key from the platform", async () => {
  const seen: string[][] = [];
  const info = await guessedKeyInfo(guessLane(seen), SECRETS.k1, SECRETS.kB, FILE);

  expect(info).toEqual(EXPECTED_INFO);
  const [[, ...argv] = [], [, script] = []] = seen;
  expect(seen.map(([label]) => label)).toEqual(['A', 'platform']);
  expect(argv.slice(0, -1)).toEqual([...NODE, aGuessScript(FILE)]);
  expect(argv.at(-1)).toMatch(/^[0-9a-f]{64}$/);
  expect(script).toBe(platformInfoScript(DOCUMENT_SERVER, INFO_KEYS));
});

it.each([
  ['A', 'reject', 'ETIMEDOUT', ['A']],
  ['A', 'differ', 'differs', ['A']],
  ['A', 'text', 'output is not JSON', ['A']],
  ['platform', 'reject', 'ETIMEDOUT', ['A', 'platform']],
  ['platform', 'differ', 'differs', ['A', 'platform']],
])('fails the %s step answering %s without a key or cause', async (step, how, reason, steps) => {
  const seen: string[][] = [];
  const lane = guessLane(seen, step, how);
  const error: unknown = await guessedKeyInfo(lane, SECRETS.k1, SECRETS.kB, FILE).catch(
    (caught: unknown) => caught,
  );

  if (!(error instanceof Error)) throw new Error('Guessed-key info did not fail');
  expect(error.message).toContain(reason);
  expect(seen.map(([label]) => label)).toEqual(steps);
  const guessed = seen[0]?.at(-1) ?? '';
  for (const secret of [...Object.values(INFO_KEYS), guessed, OTHER_K1])
    expect(error.message).not.toContain(secret);
  expect(error.message).not.toMatch(/[0-9a-f]{64}/);
  expect(error.cause).toBeUndefined();
});
