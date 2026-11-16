import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { expect } from 'vitest';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import {
  exchangeJs,
  FILE_TOKEN_PUBLIC,
  KEY_JS,
  MINT_JS,
  READ_JS,
} from './onlyoffice-probe-script.ts';
import { providerCounts, withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveLane } from './sidebar-archive-stack-fixture.ts';

const [TARGET_NAME, SOURCE_NAME] = ['隔离目标.docx', '隔离来源.docx'] as const;
const [TARGET, SOURCE] = [`${WORK}/${TARGET_NAME}`, `${WORK}/${SOURCE_NAME}`] as const;
// `node -e` hands the first extra argument to the script as process.argv[1].
const NODE = ['node', '--input-type=module', '-e'];

/** The archive lane on A, the host docker `run`, A's container `dsh-team-u-<id>` and B's lifecycle. */
export interface OfficeIsolationLane extends ArchiveLane {
  readonly run: DockerOutput;
  readonly instance: string;
  /** Runs a JSON-printing script in the platform container: the privileged position (c3). */
  readonly platformRead: (script: string) => Promise<Record<string, unknown>>;
  readonly secondEmployee: () => Promise<string>;
  /** Disables B if it was registered; a no-op otherwise. */
  readonly retire: () => Promise<void>;
}

/** The verified observations only; no key or token. */
export type OfficeIsolationEvidence = Readonly<
  Record<'a' | 'b' | 'sign' | 'attack', Readonly<Record<string, unknown>>>
>;

const CONFIG_OK = { status: 200, signed: true };
export const EXPECTED_ISOLATION = {
  a: { config: CONFIG_OK, registry: { k0: false, k1: true } },
  b: {
    connect: { a: 'blocked', b: 'connected' },
    config: CONFIG_OK,
    registry: { k0: false, k1: true },
    file: { status: 404, body: 'file not found' },
  },
  sign: { fileWithT: { status: 200, matches: true } },
};
const BAD_SIGNATURE = { status: 403, body: 'invalid token: bad-signature' };
const UNKNOWN_KEY = { status: 200, error: 1 };
/** (c3): only T reads and only the JWT-signed k1 saves; the read-back then finds the source bytes. */
export const EXPECTED_ATTACK = {
  config: { status: 403, body: { ok: false, error: { code: 'forbidden', message: 'forbidden' } } },
  file: {
    public: BAD_SIGNATURE,
    guessed: BAD_SIGNATURE,
    b: BAD_SIGNATURE,
    t: { status: 200, matches: true },
  },
  callback: {
    ...{ k0: UNKNOWN_KEY, hmacGuessed: UNKNOWN_KEY, kB: UNKNOWN_KEY },
    ...{ noJwtK1: { status: 403, error: 4 }, jwtK1: { status: 200, error: 0 } },
  },
  target: 'saved',
};
const CONFIG_PATH = `'/sidebar/onlyoffice/config?sessionId=t&path=' + encodeURIComponent(file) + '&cwd=' + encodeURIComponent(${JSON.stringify(WORK)})`;
const FILE_PATH = "'/sidebar/onlyoffice/file?token=' + encodeURIComponent";

/** Always exits 0: an error becomes `observed.error`, so a failed exec never echoes argv. Instance
 * scripts run as uid 1001 and read the per-instance secret from the container environment only. */
const script = (body: string) => `import { createHash, createHmac } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
const secret = process.env.DSH_TEAM_ONLYOFFICE_FILE_SECRET;
const file = ${JSON.stringify(TARGET)};
const observed = {};
try {
${body}
} catch (error) { observed.error = error instanceof Error ? error.message : String(error); }
process.stdout.write(JSON.stringify(observed));`;

/** Writes the target, then requests its config at `address` with a loopback Host, registering k1. */
const register = (address: string, content: string) =>
  `writeFileSync(file, ${JSON.stringify(content)});
const info = statSync(file);
${KEY_JS}
${exchangeJs(address, '127.0.0.1:3080')}
${READ_JS}
const config = json(await exchange('GET', ${CONFIG_PATH}));
observed.config = { status: config.status, signed: config.body?.signed === true };
const registry = () => { try { const { entries } = JSON.parse(readFileSync('/data/home/plugins/dsh-sidebar-onlyoffice/registry.json', 'utf8')); return { k0: entries.some((e) => e.key === k0), k1: entries.some((e) => e.key === k1) }; } catch { return { k0: false, k1: false }; } };
const deadline = Date.now() + 5000;
let seen = registry();
while ((!seen.k1 || seen.k0) && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 100)); seen = registry(); }
observed.registry = seen;`;

/** (c1) A writes both files and registers k1. */
export const aSetupScript = (address: string): string =>
  script(`writeFileSync(${JSON.stringify(SOURCE)}, 'dsh-team office isolation source');
${register(address, 'dsh-team office isolation target')}
observed.k1 = k1;`);

/** (c2) B: no TCP to A's listening :3080 within 3s, but to B's own; B registers k1_B for a same-named
 * target and signs T_B over argv[1]'s claims, which B's file route answers 404 (valid, no source). */
export const bProbeScript = (aAddress: string, bAddress: string): string =>
  script(`const probe = (host) => new Promise((resolve) => {
  const socket = connect({ host, port: 3080 });
  const timer = setTimeout(() => { socket.destroy(); resolve('blocked'); }, 3000);
  socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected'); });
  socket.on('error', () => { clearTimeout(timer); resolve('blocked'); });
});
observed.connect = { a: await probe(${JSON.stringify(aAddress)}), b: await probe(${JSON.stringify(bAddress)}) };
${register(bAddress, 'dsh-team office isolation B target')}
${MINT_JS}
const tB = mint(JSON.parse(process.argv[1]), secret);
observed.file = text(await exchange('GET', ${FILE_PATH}(tB)));
observed.kB = k1;
observed.tB = tB;`);

/** (c1') A after B retired: T over argv[1]'s claims, forgeries under the public constant and argv[2]'s
 * guessed secret, k0 and the guessed-secret HMAC of the unchanged target; T reads A's source. */
export const aSignScript = (address: string): string =>
  script(`const claims = JSON.parse(process.argv[1]);
const guessed = process.argv[2];
const info = statSync(file);
${KEY_JS}
${MINT_JS}
${exchangeJs(address, '127.0.0.1:3080')}
const t = mint(claims, secret);
const served = await exchange('GET', ${FILE_PATH}(t));
observed.fileWithT = { status: served.status, matches: served.body.equals(readFileSync(${JSON.stringify(SOURCE)})) };
Object.assign(observed, { t, k0, sourceSha: createHash('sha256').update(readFileSync(${JSON.stringify(SOURCE)})).digest('hex') });
observed.tPublic = mint(claims, ${JSON.stringify(FILE_TOKEN_PUBLIC)});
observed.tGuessed = mint(claims, guessed);
observed.kGuessed = createHmac('sha256', guessed).update(input).digest('hex');`);

/** (c3) in the platform container: each request goes to A's address with A's Host, as B's signed
 * editor config would have the Document Server send it; callbacks carry a body-`token` JWT. */
export const platformAttackScript = (address: string, inputs: object): string =>
  script(`const inputs = ${JSON.stringify(inputs)};
const jwtSecret = process.env.DOCUMENT_SERVER_JWT_SECRET;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = () => { const signed = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ exp: Math.floor(Date.now() / 1000) + 600 }); return signed + '.' + createHmac('sha256', jwtSecret).update(signed).digest('base64url'); };
${exchangeJs(address, `${address}:3080`)}
${READ_JS}
const forged = async (token) => text(await exchange('GET', ${FILE_PATH}(token)));
const source = async (token) => { const r = await exchange('GET', ${FILE_PATH}(token)); return { status: r.status, matches: createHash('sha256').update(r.body).digest('hex') === inputs.sourceSha }; };
const url = 'http://${address}:3080/sidebar/onlyoffice/file?token=' + encodeURIComponent(inputs.t);
const callback = async (key, signed) => { const r = json(await exchange('POST', '/sidebar/onlyoffice/callback', { key, status: 2, url, ...(signed ? { token: jwt() } : {}) })); return { status: r.status, error: r.body?.error }; };
observed.config = json(await exchange('GET', ${CONFIG_PATH}));
observed.file = { public: await forged(inputs.tPublic), guessed: await forged(inputs.tGuessed), b: await forged(inputs.tB), t: await source(inputs.t) };
observed.callback = { k0: await callback(inputs.k0, true), hmacGuessed: await callback(inputs.kGuessed, true), kB: await callback(inputs.kB, true), noJwtK1: await callback(inputs.k1, false), jwtK1: await callback(inputs.k1, true) };`);

/** A's target after (c3): `saved` once it holds the source bytes. */
export const aReadScript = (): string =>
  script(
    `observed.target = readFileSync(file).equals(readFileSync(${JSON.stringify(SOURCE)})) ? 'saved' : 'unchanged';`,
  );

type Secrets = readonly (string | undefined)[];

/** Replaces each non-empty secret with a marker so no key or token survives in an error. */
export function redactSecrets(message: string, secrets: Secrets): string {
  let output = message;
  for (const secret of secrets)
    if (secret !== undefined && secret !== '') output = output.replaceAll(secret, '<redacted>');
  return output;
}

export function officeIsolationLine(evidence: OfficeIsolationEvidence | undefined) {
  if (evidence === undefined) throw new Error('Office isolation evidence missing');
  return evidence;
}

type Text = 'error' | 'k1' | 'kB' | 'tB' | 't' | 'tPublic' | 'tGuessed' | 'k0' | 'kGuessed';
type Observed = Readonly<Record<string, unknown> & Partial<Record<Text, string>>>;

/** The `expected` keys of `observed`, or a redacted failure carrying the whole observation. */
function verify(label: string, observed: Observed, expected: object, secrets: Secrets) {
  const seen = Object.fromEntries(Object.keys(expected).map((key) => [key, observed[key]]));
  if (observed.error === undefined && isDeepStrictEqual(seen, expected)) return seen;
  const detail = `observed=${JSON.stringify(observed)} expected=${JSON.stringify(expected)}`;
  throw new Error(redactSecrets(`Office isolation ${label} differs: ${detail}`, secrets));
}

/** The container's address on its own bridge, base+2. */
async function instanceAddress(run: DockerOutput, name: string): Promise<string> {
  const raw = await run(['container', 'inspect', '-f', '{{json .NetworkSettings.Networks}}', name]);
  const networks = JSON.parse(raw) as Record<string, { IPAddress?: unknown } | undefined>;
  const ip = networks[name.replace('dsh-team-u-', 'dsh-team-net-')]?.IPAddress;
  if (typeof ip !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip))
    throw new Error('Office isolation instance bridge address unavailable');
  return ip;
}

/** B's whole segment, then `retire` regardless. A docker failure quotes argv, whose claims hold k1:
 * failures leave redacted and without `cause`, B's own first, a retirement failure after it. */
async function bPosition(lane: OfficeIsolationLane, aAddress: string, claims: string, k1: string) {
  const failures: unknown[] = [];
  let probe: Observed | undefined;
  try {
    const name = await lane.secondEmployee();
    const bProbe = bProbeScript(aAddress, await instanceAddress(lane.run, name));
    const stdout = await lane.run(['exec', '--user', '1001', name, ...NODE, bProbe, claims]);
    probe = JSON.parse(stdout) as Observed;
  } catch (error) {
    failures.push(error);
  }
  await lane.retire().catch((error: unknown) => failures.push(error));
  if (probe !== undefined && failures.length === 0) return probe;
  const messages = failures.map((f) => (f instanceof Error ? f.message : String(f)));
  throw new Error(redactSecrets(`Office isolation (c2) failed: ${messages.join('\n')}`, [k1]));
}

/** `step`'s result, or its failure redacted and without `cause`: docker quotes argv and scripts. */
async function guarded(label: string, secrets: Secrets, step: () => Promise<string>) {
  const output = await step().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(`Office isolation ${label} failed: ${message}`, secrets));
  });
  return JSON.parse(output) as Observed;
}

async function officeIsolation(lane: OfficeIsolationLane): Promise<OfficeIsolationEvidence> {
  const before = await providerCounts(lane);
  const aAddress = await instanceAddress(lane.run, lane.instance);
  const setup = JSON.parse(await lane.exec([...NODE, aSetupScript(aAddress)])) as Observed;
  const { k1 } = setup;
  const a = verify('(c1)', setup, EXPECTED_ISOLATION.a, [k1]);
  if (k1 === undefined) throw new Error('Office isolation (c1) returned no k1');
  const exp = Math.floor(Date.now() / 1000) + 600;
  const claims = JSON.stringify({ key: k1, path: SOURCE, cwd: WORK, exp });
  const probe = await bPosition(lane, aAddress, claims, k1);
  const { kB, tB } = probe;
  const b = verify('(c2)', probe, EXPECTED_ISOLATION.b, [k1, kB, tB]);
  const guessed = randomBytes(32).toString('hex');
  const signArgs = [...NODE, aSignScript(aAddress), claims, guessed];
  const signed = await guarded("(c1')", [k1, kB, tB, guessed], () => lane.exec(signArgs));
  const { t, tPublic, tGuessed, k0, kGuessed } = signed;
  const secrets = [k1, kB, tB, guessed, t, tPublic, tGuessed, kGuessed, k0];
  const sign = verify("(c1')", signed, EXPECTED_ISOLATION.sign, secrets);
  const attackScript = platformAttackScript(aAddress, { ...signed, k1, kB, tB });
  const attacked = await guarded('(c3)', secrets, async () =>
    JSON.stringify(await lane.platformRead(attackScript)),
  );
  const read = JSON.parse(await lane.exec([...NODE, aReadScript()])) as Observed;
  const attack = verify('(c3)', { ...attacked, ...read }, EXPECTED_ATTACK, secrets);
  expect(await providerCounts(lane), 'No model request or retrieval').toEqual(before);
  return { a, b, sign, attack };
}

/** 18.5 (#440): B cannot reach A and each instance registers only its own key; from the privileged
 * platform position every forged token and unregistered key is refused, and only A's T and k1 work. */
export const officeIsolationScenario = (lane: OfficeIsolationLane) =>
  withWorkFiles(lane, [TARGET_NAME, SOURCE_NAME], 'Office isolation', () => officeIsolation(lane));
