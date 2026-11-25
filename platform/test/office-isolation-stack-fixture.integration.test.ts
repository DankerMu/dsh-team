import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect, isDeepStrictEqual } from 'node:util';
import { afterAll, expect, it } from 'vitest';
import {
  aGuessScript,
  aReadScript,
  aSetupScript,
  aSignScript,
  bCrossScript,
  bProbeScript,
  CROSS_JS,
  EXPECTED_ATTACK,
  EXPECTED_INFO,
  EXPECTED_ISOLATION,
  guessedKeyInfo,
  NODE,
  officeIsolationLine,
  officeIsolationScenario,
  platformAttackScript,
  namespaceInfoScript,
  REGISTRY,
  registryKeys,
} from './office-isolation-stack-fixture.ts';
import { JWT_JS } from './onlyoffice-probe-script.ts';
import type { OfficeIsolationLane } from './office-isolation-stack-fixture.ts';
import { record } from './docker-cleanup.ts';
import { localScript } from './local-script.ts';
import { redactSecrets } from './stack-browser-fixture.ts';

const A = '10.0.0.2';
const B = '10.0.1.2';
const SECRETS = {
  ...{ k1: 'a1'.repeat(32), kB: 'b1'.repeat(32), k0: 'c0'.repeat(32), kCross: 'd1'.repeat(32) },
  ...{ t: 'tok-t', tPublic: 'tok-p', tB: 'tok-b' },
};
// A's key input as A's script emits it: A's host name, never the local one, and NUL separators.
const INPUT = ['dsh-team-u-a', '/data/work/隔离目标.docx', '31', '1700000000000'].join('\0');

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
    'observed.input = input;',
  ])
    expect(script).toContain(part);
  expect(script).not.toContain('process.argv');
});

it("probes A then B over TCP, signs T_B over argv[1]'s claims and derives kCross from argv[2] (c2)", () => {
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
    CROSS_JS,
    'observed.kCross = cross(process.argv[2]);',
  ])
    expect(script).toContain(part);
  expect(script).not.toContain('request({ host: "10.0.0.2"');
});

it("signs T and the public-constant token over argv[1] and reads the source with T (c1')", () => {
  const script = aSignScript(A);

  for (const part of [
    'const claims = JSON.parse(process.argv[1]);',
    'const info = statSync(file);',
    'request({ host: "10.0.0.2", port: 3080',
    "const headers = { host: '127.0.0.1:3080' };",
    'const t = mint(claims, secret);',
    'observed.tPublic = mint(claims, "dsh-sidebar-onlyoffice/file-token/v1");',
    'served.body.equals(readFileSync("/data/work/隔离来源.docx"))',
  ])
    expect(script).toContain(part);
  expect(script).not.toContain('process.argv[2]');
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
    'observed.file = { public: await forged(inputs.tPublic), b: await forged(inputs.tB), t: await source(inputs.t) };',
    'observed.callback = { k0: await callback(inputs.k0, true), kCross: await callback(inputs.kCross, true), kB: await callback(inputs.kB, true), noJwtK1: await callback(inputs.k1, false), jwtK1: await callback(inputs.k1, true) };',
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
      b: badSignature,
      t: { status: 200, matches: true },
    },
    callback: {
      ...{ k0: unknownKey, kCross: unknownKey, kB: unknownKey },
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
function fakeLane(events: string[], failing = '', how = 'reject', argvs: string[][] = []) {
  const { k1, kB, tB, kCross, ...signed } = SECRETS;
  const { config, file, callback } = EXPECTED_ATTACK;
  const answer = (label: string, args: readonly string[], reply: object) => {
    events.push(label);
    argvs.push([label, ...args]);
    if (label !== failing) return Promise.resolve(JSON.stringify(reply));
    if (how === 'text') return Promise.resolve(`${SECRETS.k1} is no JSON`);
    if (how === 'shared') return Promise.resolve(JSON.stringify({ ...reply, kCross: k1 }));
    if (how === 'differ')
      return Promise.resolve(JSON.stringify({ ...reply, ...SECRETS, ...DIFFER[label] }));
    return Promise.reject(new Error(`docker ${args.join(' ')} failed (null): ETIMEDOUT`));
  };
  const replies = [
    ['observed.k1 = k1', 'setup', { ...EXPECTED_ISOLATION.a, k1, input: INPUT }],
    ['fileWithT', 'sign', { ...EXPECTED_ISOLATION.sign, ...signed, sourceSha: 'sha-of-source' }],
    ['observed.target', 'read', { target: 'saved' }],
  ] as const;
  const address = { IPAddress: A };
  const parsed = async (reply: Promise<string>) => record(JSON.parse(await reply));
  const lane: OfficeIsolationLane = {
    ...{ session: {} as never, instance: 'dsh-team-u-a' },
    run: (args) =>
      args[0] === 'container'
        ? Promise.resolve(JSON.stringify({ [(args[4] ?? '').replace('-u-', '-net-')]: address }))
        : answer('b', args, { ...EXPECTED_ISOLATION.b, kB, tB, kCross }),
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
  return lane;
}

it('signs T after B retires, attacks from the platform, reads the target back, then counts the provider', async () => {
  const [events, argvs]: [string[], string[][]] = [[], []];
  const evidence = officeIsolationLine(
    await officeIsolationScenario(fakeLane(events, '', '', argvs)),
  );

  expect(evidence).toEqual({ ...EXPECTED_ISOLATION, attack: EXPECTED_ATTACK });
  expect(events.join(' ')).toBe('provider setup b retire sign attack read provider clean');
  const exec = argvs.find(([label]) => label === 'b') ?? [];
  expect(exec.slice(-2, -1)[0]).toContain(`"key":"${SECRETS.k1}"`);
  expect(exec.at(-1), "A's key input, JSON-encoded, after B's claims").toBe(JSON.stringify(INPUT));
  const attack = argvs.find(([label]) => label === 'attack')?.[1] ?? '';
  expect(attack).toContain(`"kCross":"${SECRETS.kCross}"`);
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
    ['b', 'text', 'output is not JSON'],
    ['b', 'shared', "B's secret over A's key input"],
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

it("expects A's and B's keys to name their one editor, k0 and B's secret over A's input no session", () => {
  expect(EXPECTED_INFO).toEqual({ k1: OPEN, kB: OPEN, k0: UNKNOWN, kCross: UNKNOWN });
});

const hex = () => randomBytes(32).toString('hex');

it('signs a JWT whose payload is only exp without claims, and the claims before exp with them', async () => {
  const signer = `import { createHmac } from 'node:crypto';
const jwtSecret = 'jwt-secret';
${JWT_JS}
process.stdout.write(JSON.stringify([jwt(), jwt({ c: 'info', key: 'K' })]));`;
  const tokens = (await localScript(signer, [], {})) as string[];
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

const hmac = (key: string, input: string) => createHmac('sha256', key).update(input).digest('hex');
const secretEnv = (secret: string) => ({ DSH_TEAM_ONLYOFFICE_FILE_SECRET: secret });
const cross = async (input: string, secret: string) =>
  record(await localScript(bCrossScript(), [JSON.stringify(input)], secretEnv(secret))).kCross;

it("recomputes A's k1 and k0 and emits the file's key input", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-office-guess-'));
  const file = join(dir, '编辑写回.docx');
  const secret = hex();
  try {
    writeFileSync(file, 'dsh-team office cross key');
    const observed = await localScript(aGuessScript(file), [], secretEnv(secret));
    const { size, mtimeMs } = statSync(file);
    const input = [hostname(), file, String(size), String(Math.round(mtimeMs))].join('\0');
    const k0 = createHash('sha256').update(input).digest('hex');
    expect(observed).toEqual({ k1: hmac(secret, input), k0, input });
    expect((await cross(input, secret)) === record(observed).k1, 'B sharing A secret').toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("derives kCross in B from A's JSON-encoded input with B's secret: A's key only if they share it", async () => {
  const [a, b] = [hex(), hex()];

  const [shared, own] = [await cross(INPUT, a), await cross(INPUT, b)];

  expect(hostname()).not.toBe('dsh-team-u-a');
  expect({
    shared: shared === hmac(a, INPUT),
    own: own === hmac(b, INPUT),
    differ: own !== shared,
  }).toEqual({ shared: true, own: true, differ: true });
  expect(bCrossScript()).toContain(CROSS_JS);
  expect(record(await localScript(bCrossScript(), [JSON.stringify(INPUT)], {}))).toHaveProperty(
    'error',
  );
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

const INFO_KEYS = { k1: SECRETS.k1, kB: SECRETS.kB, k0: SECRETS.k0, kCross: SECRETS.kCross };

it('posts info for each key over loopback with a body-token JWT read from stdin and keeps no key', async () => {
  const stub = await commandStub([SECRETS.k1, SECRETS.kB]);
  try {
    const script = namespaceInfoScript(INFO_KEYS, stub.port);
    const env = { DOCUMENT_SERVER_JWT_SECRET: hex() };
    const observed = await localScript(script, [], env, JWT_SECRET);
    expect(observed).toEqual(EXPECTED_INFO);
    expect(stub.seen).toEqual(Array(4).fill('127.0.0.1 info true'));
    for (const key of Object.values(INFO_KEYS)) expect(JSON.stringify(observed)).not.toContain(key);
    const forged = await localScript(script, [], { DOCUMENT_SERVER_JWT_SECRET: JWT_SECRET }, hex());
    const refused = { status: 200, error: 6 };
    expect(forged).toEqual({ k1: refused, kB: refused, k0: refused, kCross: refused });
  } finally {
    await stub.close();
  }
  const delivered = namespaceInfoScript(INFO_KEYS);
  expect(delivered).toContain('request({ host: "127.0.0.1", port: 80, method');
  expect(delivered).toContain("const headers = { host: '127.0.0.1' };");
  expect(delivered).toContain("const jwtSecret = readFileSync(0, 'utf8');");
});

const FILE = '/data/work/编辑写回.docx';
const OTHER_K1 = 'e1'.repeat(32);
// A answering another key; B under a shared secret; the holder knowing B's key for A's file.
const DIFFERS: Record<string, object> = {
  A: { k1: OTHER_K1, k0: SECRETS.k0, input: INPUT },
  B: { kCross: SECRETS.k1 },
  holder: { ...EXPECTED_INFO, kCross: { ...OPEN, key: SECRETS.kCross } },
};

/** A's and B's execs and the holder answering as the stack does; `failing` rejects quoting argv,
 * answers `DIFFERS`, or answers a key as non-JSON text. `seen` gets each step's label and argv. */
function guessLane(seen: string[][], failing = '', how = 'reject') {
  const answer = (label: string, args: readonly string[], reply: object) => {
    seen.push([label, ...args]);
    if (label !== failing) return Promise.resolve(JSON.stringify(reply));
    if (how === 'text') return Promise.resolve(`${SECRETS.k1} is no JSON`);
    if (how === 'differ') return Promise.resolve(JSON.stringify(DIFFERS[label]));
    return Promise.reject(new Error(`docker ${args.join(' ')} failed (null): ETIMEDOUT`));
  };
  const own = { k1: SECRETS.k1, k0: SECRETS.k0, input: INPUT };
  const lane = {
    exec: (args: readonly string[]) => answer('A', args, own),
    namespaceRead: async (script: string) =>
      record(JSON.parse(await answer('holder', [script], EXPECTED_INFO))),
  };
  return [
    lane,
    { exec: (args: readonly string[]) => answer('B', args, { kCross: SECRETS.kCross }) },
  ] as const;
}

it("recomputes k1 in A, derives kCross in B from A's input, then asks the holder about all four", async () => {
  const seen: string[][] = [];
  const info = await guessedKeyInfo(...guessLane(seen), SECRETS.k1, SECRETS.kB, FILE);

  expect(info).toEqual(EXPECTED_INFO);
  const [[, ...argv] = [], [, ...crossArgv] = [], [, script] = []] = seen;
  expect(seen.map(([label]) => label)).toEqual(['A', 'B', 'holder']);
  expect(argv).toEqual([...NODE, aGuessScript(FILE)]);
  expect(crossArgv).toEqual([...NODE, bCrossScript(), JSON.stringify(INPUT)]);
  expect(script).toBe(namespaceInfoScript(INFO_KEYS));
});

it.each([
  ['A', 'reject', 'ETIMEDOUT', ['A']],
  ['A', 'differ', 'differs', ['A']],
  ['A', 'text', 'output is not JSON', ['A']],
  ['B', 'reject', 'ETIMEDOUT', ['A', 'B']],
  ['B', 'differ', "B's secret over A's key input", ['A', 'B']],
  ['B', 'text', 'output is not JSON', ['A', 'B']],
  ['holder', 'reject', 'ETIMEDOUT', ['A', 'B', 'holder']],
  ['holder', 'differ', 'differs', ['A', 'B', 'holder']],
])('fails the %s step answering %s without a key or cause', async (step, how, reason, steps) => {
  const seen: string[][] = [];
  const lanes = guessLane(seen, step, how);
  const error: unknown = await guessedKeyInfo(...lanes, SECRETS.k1, SECRETS.kB, FILE).catch(
    (caught: unknown) => caught,
  );

  if (!(error instanceof Error)) throw new Error('Cross-key info did not fail');
  expect(error.message).toContain(reason);
  expect(seen.map(([label]) => label)).toEqual(steps);
  for (const secret of [...Object.values(INFO_KEYS), OTHER_K1])
    expect(error.message).not.toContain(secret);
  expect(error.message).not.toMatch(/[0-9a-f]{64}/);
  expect(error.cause).toBeUndefined();
});

const REGISTRIES = mkdtempSync(join(tmpdir(), 'dsh-team-office-registry-'));
afterAll(() => {
  rmSync(REGISTRIES, { recursive: true, force: true });
});
const WANTED = '/data/work/编辑写回.docx';
const [K1, K2, K3, K4] = [hex(), hex(), hex(), hex()];
// A record as plugin 0.2.0 writes it (`{ key, entry: DocumentEntry, lastSeen }`, `src/registry.ts`).
const row = (key: unknown, path: unknown = WANTED) => {
  const entry = { path, title: 'x.docx', ext: 'docx', cwd: '/data/work', dsBase: '/ds', size: 9 };
  return { key, entry: { ...entry, mtimeMs: 1_700_000_000_000 }, lastSeen: 1_700_000_000_000 };
};
const registryFile = (name: string, content: unknown) => {
  const file = join(REGISTRIES, `${name.replaceAll(' ', '-')}.json`);
  const raw =
    typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content);
  writeFileSync(file, raw);
  return file;
};

// registryKeys' argv around its script: python3 isolated, the container registry, the path.
const ARGV = ['python3', '-I', '-c', REGISTRY, WANTED];
/** registryKeys' own argv under the local `python3 -I`, the registry at `file`: the run's status,
 * stdout and stderr, then registryKeys' keys or its rejection message. */
async function query(file: string) {
  const run = { status: -1, stdout: '', stderr: '' };
  const exec = (argv: readonly string[]) => {
    const [command, isolated, flag, source = '', registry, path = '', ...rest] = argv;
    expect([command, isolated, flag, registry, path, ...rest]).toEqual(ARGV);
    const done = spawnSync('python3', ['-I', '-c', source, file, path], { encoding: 'utf8' });
    Object.assign(run, { status: done.status ?? -1, stdout: done.stdout, stderr: done.stderr });
    const failed = new Error(`exit ${String(done.status)}: ${done.stderr}`);
    return done.status === 0 ? Promise.resolve(done.stdout) : Promise.reject(failed);
  };
  const keys = await registryKeys({ exec }, WANTED).catch((error: unknown) => ({
    rejected: error instanceof Error ? error.message : String(error),
  }));
  return { ...run, keys };
}

/** A refusal: exit 2, nothing on stdout, exactly `message` on stderr, which registryKeys rejects
 * with; neither stream names a key, the queried path or the registry file. */
async function refused(file: string, message: string) {
  const result = await query(file);
  expect(result).toEqual({
    status: 2,
    stdout: '',
    stderr: `${message}\n`,
    keys: { rejected: `exit 2: ${message}\n` },
  });
  for (const text of [K1, K2, WANTED, file])
    expect(result.stdout + result.stderr).not.toContain(text);
}

it('lists the keys of the records naming the path exactly, in file order, and no other key', async () => {
  const other = [row(K2, '/data/work/其他.docx'), row(K4, `${WANTED}.bak`)];
  const file = registryFile('valid', { version: 1, entries: [row(K1), ...other, row(K3)] });

  const result = await query(file);

  const stdout = `["${K1}", "${K3}"]\n`;
  expect(result).toEqual({ status: 0, stdout, stderr: '', keys: [K1, K3] });
});

it.each([
  ['a missing file', join(REGISTRIES, 'absent.json')],
  ['a missing parent directory', join(REGISTRIES, 'absent', 'registry.json')],
  ['records of other paths only', registryFile('other', { version: 1, entries: [row(K2, '/x')] })],
  ['no records', registryFile('none', { version: 1, entries: [] })],
])(
  'answers [] with exit 0 for %s: not written yet, or no key for the path',
  async (_case, file) => {
    const result = await query(file);

    expect(result).toEqual({ status: 0, stdout: '[]\n', stderr: '', keys: [] });
  },
);

it('refuses a directory at the registry path as unreadable', async () => {
  const file = join(REGISTRIES, 'directory.json');
  mkdirSync(file);

  await refused(file, 'registry unreadable');
});

const VALID = row(K1);
it.each([
  ['json', 'invalid JSON', `{"version": 1, "entries": [${JSON.stringify(VALID)}`],
  ['json', 'non-UTF-8 bytes', Buffer.from([0x7b, 0xff, 0x7d])],
  ['object', 'a top-level list', [VALID]],
  ['version', 'version 2', { version: 2, entries: [VALID] }],
  ['version', 'no version', { entries: [VALID] }],
  ['version', 'version true', { version: true, entries: [VALID] }],
  ['entries', 'no entries', { version: 1 }],
  ['entries', 'an entries object', { version: 1, entries: { [K1]: VALID } }],
  ['record', 'a string record', { version: 1, entries: [VALID, K2] }],
  ['key', 'a record without key', { version: 1, entries: [VALID, { entry: { path: WANTED } }] }],
  ['key', 'a numeric key', { version: 1, entries: [VALID, row(7)] }],
  ['key', 'an empty key', { version: 1, entries: [VALID, row('')] }],
  ['entry', 'a record without entry', { version: 1, entries: [VALID, { key: K2 }] }],
  ['entry', 'a null entry', { version: 1, entries: [VALID, { key: K2, entry: null }] }],
  ['path', 'an entry without path', { version: 1, entries: [VALID, { key: K2, entry: {} }] }],
  ['path', 'a numeric path', { version: 1, entries: [VALID, row(K2, 7)] }],
])(
  'refuses with format mismatch: %s, after a valid matching record, for %s',
  async (kind, name, content) => {
    const file = registryFile(name, content);

    await refused(file, `registry format mismatch: ${kind}`);
  },
);

it.each([
  ['non-JSON', `[${K1}`],
  ['a non-list', JSON.stringify({ key: K1 })],
  ['a non-string element', JSON.stringify([K1, 7])],
  ['an empty string', JSON.stringify([K1, ''])],
  ['null', 'null'],
])('rejects %s query output with the fixed message, never quoting it', async (_case, output) => {
  const exec = () => Promise.resolve(output);

  const error: unknown = await registryKeys({ exec }, WANTED).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty('message', 'Office registry keys output is not a list of keys');
  expect(inspect(error)).not.toContain(K1);
});
