import { expect, it } from 'vitest';
import {
  aReadScript,
  aSetupScript,
  aSignScript,
  bProbeScript,
  EXPECTED_ATTACK,
  EXPECTED_ISOLATION,
  officeIsolationLine,
  officeIsolationScenario,
  platformAttackScript,
  redactSecrets,
} from './office-isolation-stack-fixture.ts';
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
    "b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ exp: Math.floor(Date.now() / 1000) + 600 })",
    "'http://10.0.0.2:3080/sidebar/onlyoffice/file?token=' + encodeURIComponent(inputs.t)",
    "'/sidebar/onlyoffice/callback', { key, status: 2, url, ...(signed ? { token: jwt() } : {}) }",
    'observed.file = { public: await forged(inputs.tPublic), guessed: await forged(inputs.tGuessed), b: await forged(inputs.tB), t: await source(inputs.t) };',
    'observed.callback = { k0: await callback(inputs.k0, true), hmacGuessed: await callback(inputs.kGuessed, true), kB: await callback(inputs.kB, true), noJwtK1: await callback(inputs.k1, false), jwtK1: await callback(inputs.k1, true) };',
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

/** A, B and the platform answering as the stack does; `failing` rejects that step as `output()` would, argv included. */
function fakeLane(events: string[], failing = ''): OfficeIsolationLane {
  const { k1, kB, tB, ...signed } = SECRETS;
  const { config, file, callback } = EXPECTED_ATTACK;
  const answer = (label: string, args: readonly string[], reply: object) => {
    events.push(label);
    if (label !== failing) return Promise.resolve(JSON.stringify(reply));
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

it.each(['b', 'sign', 'attack'])(
  'redacts every key and token from a rejected %s exec and still retires B',
  async (step) => {
    const events: string[] = [];
    const error: unknown = await officeIsolationScenario(fakeLane(events, step)).catch(
      (caught: unknown) => caught,
    );

    if (!(error instanceof Error)) throw new Error('Office isolation scenario did not fail');
    expect(error.message).toContain('ETIMEDOUT');
    for (const secret of Object.values(SECRETS)) expect(error.message).not.toContain(secret);
    expect(error.message).not.toMatch(/[0-9a-f]{64}/);
    expect(error.cause).toBeUndefined();
    expect(events.filter((event) => event === 'retire')).toHaveLength(1);
  },
);
