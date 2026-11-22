import { isDeepStrictEqual } from 'node:util';
import { expect } from 'vitest';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import type { NamespaceRead } from './document-server-net-fixture.ts';
import {
  CALLBACK_JS,
  exchangeJs,
  FILE_TOKEN_PUBLIC,
  JWT_JS,
  KEY_JS,
  MINT_JS,
  READ_JS,
} from './onlyoffice-probe-script.ts';
import { providerCounts, withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveLane } from './sidebar-archive-stack-fixture.ts';

const [TARGET_NAME, SOURCE_NAME] = ['隔离目标.docx', '隔离来源.docx'] as const;
const [TARGET, SOURCE] = [`${WORK}/${TARGET_NAME}`, `${WORK}/${SOURCE_NAME}`] as const;
// `node -e` hands the first extra argument to the script as process.argv[1].
export const NODE = ['node', '--input-type=module', '-e'];

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
    b: BAD_SIGNATURE,
    t: { status: 200, matches: true },
  },
  callback: {
    ...{ k0: UNKNOWN_KEY, kCross: UNKNOWN_KEY, kB: UNKNOWN_KEY },
    ...{ noJwtK1: { status: 403, error: 4 }, jwtK1: { status: 200, error: 0 } },
  },
  target: 'saved',
};
const EDITING = { status: 200, error: 0, users: ['dsh'] };
/** Command Service `info`: A's and B's open sessions with their one editor; no session for the rest. */
export const EXPECTED_INFO = { k1: EDITING, kB: EDITING, k0: UNKNOWN_KEY, kCross: UNKNOWN_KEY };
const CONFIG_PATH = `'/sidebar/onlyoffice/config?sessionId=t&path=' + encodeURIComponent(file) + '&cwd=' + encodeURIComponent(${JSON.stringify(WORK)})`;
const FILE_PATH = "'/sidebar/onlyoffice/file?token=' + encodeURIComponent";
export const REGISTRY = '/data/home/plugins/dsh-sidebar-onlyoffice/registry.json';
// The keys of argv[1]'s records whose entry.path is argv[2], in file order, printed once after every
// record passed the plugin 0.2.0 format (`{ version: 1, entries: [{ key, entry: { path } }] }`).
// The plugin renames a whole temporary file over it and never deletes it: no file means not written
// yet, so []. Anything else fails with exit 2 and a fixed message that names no key or path.
const REGISTRY_KEYS = `import json, sys
class Refused(Exception):
    pass
def check(ok, kind):
    if not ok:
        raise Refused("registry format mismatch: " + kind)
def keys(name, path):
    try:
        with open(name, "rb") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return []
    except OSError:
        raise Refused("registry unreadable")
    try:
        registry = json.loads(raw)
    except (ValueError, RecursionError):
        raise Refused("registry format mismatch: json")
    check(isinstance(registry, dict), "object")
    version = registry.get("version")
    check(type(version) is int and version == 1, "version")
    entries = registry.get("entries")
    check(isinstance(entries, list), "entries")
    found = []
    for record in entries:
        check(isinstance(record, dict), "record")
        key = record.get("key")
        check(isinstance(key, str) and key != "", "key")
        entry = record.get("entry")
        check(isinstance(entry, dict), "entry")
        check(isinstance(entry.get("path"), str), "path")
        if entry["path"] == path:
            found.append(key)
    return found
try:
    found = keys(sys.argv[1], sys.argv[2])
except Refused as refused:
    sys.stderr.write(str(refused) + "\\n")
    sys.exit(2)
print(json.dumps(found))`;
const isKeys = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((key) => typeof key === 'string' && key !== '');

/** The keys A's registry maps to `path`; [] until it is written. A failed query rejects through
 * `exec`; output that is not a list of keys rejects with a fixed message that never quotes it. */
export async function registryKeys(lane: Pick<ArchiveLane, 'exec'>, path: string) {
  const output = await lane.exec(['python3', '-I', '-c', REGISTRY_KEYS, REGISTRY, path]);
  let keys: unknown;
  try {
    keys = JSON.parse(output);
  } catch {
    // A syntax error quotes the output, which may hold keys: the fixed message below replaces it.
  }
  if (!isKeys(keys)) throw new Error('Office registry keys output is not a list of keys');
  return keys;
}

/** Always exits 0: an error becomes `observed.error`, so a failed exec never echoes argv. Instance
 * scripts run as uid 1001 and read the per-instance secret from the container environment only. */
export const script = (
  body: string,
  file: string = TARGET,
) => `import { createHash, createHmac } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
const secret = process.env.DSH_TEAM_ONLYOFFICE_FILE_SECRET;
const file = ${JSON.stringify(file)};
const observed = {};
try {
${body}
} catch (error) { observed.error = error instanceof Error ? error.message : String(error); }
process.stdout.write(JSON.stringify(observed));`;

/** Writes the target, then requests its config at `address` with a loopback Host, registering k1. */
export const register = (address: string, content: string) =>
  `writeFileSync(file, ${JSON.stringify(content)});
const info = statSync(file);
${KEY_JS}
${exchangeJs(address, '127.0.0.1:3080')}
${READ_JS}
const config = json(await exchange('GET', ${CONFIG_PATH}));
observed.config = { status: config.status, signed: config.body?.signed === true };
const registry = () => { try { const { entries } = JSON.parse(readFileSync('${REGISTRY}', 'utf8')); return { k0: entries.some((e) => e.key === k0), k1: entries.some((e) => e.key === k1) }; } catch { return { k0: false, k1: false }; } };
const deadline = Date.now() + 5000;
let seen = registry();
while ((!seen.k1 || seen.k0) && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 100)); seen = registry(); }
observed.registry = seen;`;

/** (c1) A writes both files and registers k1; its key input holds no secret. */
export const aSetupScript = (address: string): string =>
  script(`writeFileSync(${JSON.stringify(SOURCE)}, 'dsh-team office isolation source');
${register(address, 'dsh-team office isolation target')}
observed.k1 = k1;
observed.input = input;`);

/** In B: the HMAC under B's own secret over A's key input, JSON-encoded because argv cannot carry
 * its NULs; A's key only if all instances share one secret. Never KEY_JS, which reads B's host. */
export const CROSS_JS = `const cross = (encoded) => createHmac('sha256', secret).update(JSON.parse(encoded)).digest('hex');`;

/** B's kCross over argv[1], A's JSON-encoded key input. */
export const bCrossScript = (): string =>
  script(`${CROSS_JS}
observed.kCross = cross(process.argv[1]);`);

/** (c2) B: no TCP to A's listening :3080 within 3s, but to B's own; B registers k1_B for a same-named
 * target, signs T_B over argv[1]'s claims, which B's file route answers 404 (valid, no source), and
 * derives kCross from argv[2], A's JSON-encoded key input. */
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
observed.tB = tB;
${CROSS_JS}
observed.kCross = cross(process.argv[2]);`);

/** (c1') A after B retired: T over argv[1]'s claims, a forgery under the public constant and k0 of
 * the unchanged target; T reads A's source. */
export const aSignScript = (address: string): string =>
  script(`const claims = JSON.parse(process.argv[1]);
const info = statSync(file);
${KEY_JS}
${MINT_JS}
${exchangeJs(address, '127.0.0.1:3080')}
const t = mint(claims, secret);
const served = await exchange('GET', ${FILE_PATH}(t));
observed.fileWithT = { status: served.status, matches: served.body.equals(readFileSync(${JSON.stringify(SOURCE)})) };
Object.assign(observed, { t, k0, sourceSha: createHash('sha256').update(readFileSync(${JSON.stringify(SOURCE)})).digest('hex') });
observed.tPublic = mint(claims, ${JSON.stringify(FILE_TOKEN_PUBLIC)});`);

/** (c3) in the platform container: each request goes to A's address with A's Host, as B's signed
 * editor config would have the Document Server send it; callbacks carry a body-`token` JWT. */
export const platformAttackScript = (address: string, inputs: object): string =>
  script(`const inputs = ${JSON.stringify(inputs)};
const jwtSecret = process.env.DOCUMENT_SERVER_JWT_SECRET;
${JWT_JS}
${exchangeJs(address, `${address}:3080`)}
${READ_JS}
const forged = async (token) => text(await exchange('GET', ${FILE_PATH}(token)));
const source = async (token) => { const r = await exchange('GET', ${FILE_PATH}(token)); return { status: r.status, matches: createHash('sha256').update(r.body).digest('hex') === inputs.sourceSha }; };
const url = 'http://${address}:3080/sidebar/onlyoffice/file?token=' + encodeURIComponent(inputs.t);
${CALLBACK_JS}
observed.config = json(await exchange('GET', ${CONFIG_PATH}));
observed.file = { public: await forged(inputs.tPublic), b: await forged(inputs.tB), t: await source(inputs.t) };
observed.callback = { k0: await callback(inputs.k0, true), kCross: await callback(inputs.kCross, true), kB: await callback(inputs.kB, true), noJwtK1: await callback(inputs.k1, false), jwtK1: await callback(inputs.k1, true) };`);

/** A's k1, k0 and key input for `file` as it is now. */
export const aGuessScript = (file: string): string =>
  script(
    `const info = statSync(file);
${KEY_JS}
Object.assign(observed, { k1, k0, input });`,
    file,
  );

/** In the Document Server's namespace: Command Service `info` for each of `keys` at loopback `port`
 * with a body-`token` JWT signed by the secret on stdin; each answer's status, error and users only. */
export const namespaceInfoScript = (keys: object, port = 80): string =>
  script(`const jwtSecret = readFileSync(0, 'utf8');
${JWT_JS}
${exchangeJs('127.0.0.1', '127.0.0.1', port)}
${READ_JS}
for (const [name, key] of Object.entries(${JSON.stringify(keys)})) {
  const { status, body } = json(await exchange('POST', '/command', { c: 'info', key, token: jwt({ c: 'info', key }) }));
  observed[name] = { status, ...Object.fromEntries(['error', 'users'].flatMap((field) => body?.[field] === undefined ? [] : [[field, body[field]]])) };
}`);

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

type Text = 'error' | 'k1' | 'kB' | 'tB' | 't' | 'tPublic' | 'k0' | 'kCross' | 'input';
type Observed = Readonly<Record<string, unknown> & Partial<Record<Text, string>>>;

/** The `expected` keys of `observed`, or a redacted failure carrying the whole observation. */
export function verify(label: string, observed: Observed, expected: object, secrets: Secrets) {
  const seen = Object.fromEntries(Object.keys(expected).map((key) => [key, observed[key]]));
  if (observed.error === undefined && isDeepStrictEqual(seen, expected)) return seen;
  const detail = `observed=${JSON.stringify(observed)} expected=${JSON.stringify(expected)}`;
  throw new Error(redactSecrets(`Office isolation ${label} differs: ${detail}`, secrets));
}

/** The container's address on its own bridge, base+2. */
export async function instanceAddress(run: DockerOutput, name: string): Promise<string> {
  const raw = await run(['container', 'inspect', '-f', '{{json .NetworkSettings.Networks}}', name]);
  const networks = JSON.parse(raw) as Record<string, { IPAddress?: unknown } | undefined>;
  const ip = networks[name.replace('dsh-team-u-', 'dsh-team-net-')]?.IPAddress;
  if (typeof ip !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip))
    throw new Error('Office isolation instance bridge address unavailable');
  return ip;
}

/** B's whole segment, then `retire` regardless. A docker failure quotes argv, whose claims hold k1:
 * failures leave redacted and without `cause`, B's own first, a retirement failure after it. */
async function bPosition(lane: OfficeIsolationLane, aAddress: string, claims: string, a: Observed) {
  const failures: unknown[] = [];
  let probe: Observed | undefined;
  try {
    const name = await lane.secondEmployee();
    const bProbe = bProbeScript(aAddress, await instanceAddress(lane.run, name));
    const argv = ['exec', '--user', '1001', name, ...NODE, bProbe, claims, JSON.stringify(a.input)];
    probe = await guarded('B', [a.k1], () => lane.run(argv));
  } catch (error) {
    failures.push(error);
  }
  await lane.retire().catch((error: unknown) => failures.push(error));
  if (probe !== undefined && failures.length === 0) return probe;
  const messages = failures.map((f) => (f instanceof Error ? f.message : String(f)));
  const failed = `Office isolation (c2) failed: ${messages.join('\n')}`;
  throw new Error(redactSecrets(failed, [a.k1, probe?.kCross]));
}

/** B's secret over A's key input must not give A's key: a shared secret would. No value is printed. */
function crossDiffers(kCross: string | undefined, kA: string) {
  const differs = typeof kCross === 'string' && /^[0-9a-f]{64}$/.test(kCross) && kCross !== kA;
  expect(differs, "B's secret over A's key input gives a key other than A's").toBe(true);
}

/** `step`'s parsed result, or its failure redacted and without `cause`: docker quotes argv and
 * scripts; a JSON syntax error quotes an unredactable prefix of the output, so it is dropped. */
export async function guarded(label: string, secrets: Secrets, step: () => Promise<string>) {
  const output = await step().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(`Office isolation ${label} failed: ${message}`, secrets));
  });
  try {
    return JSON.parse(output) as Observed;
  } catch {
    throw new Error(`Office isolation ${label} failed: output is not JSON`);
  }
}

async function officeIsolation(lane: OfficeIsolationLane): Promise<OfficeIsolationEvidence> {
  const before = await providerCounts(lane);
  const aAddress = await instanceAddress(lane.run, lane.instance);
  const setup = JSON.parse(await lane.exec([...NODE, aSetupScript(aAddress)])) as Observed;
  const { k1 } = setup;
  const a = verify('(c1)', setup, EXPECTED_ISOLATION.a, [k1]);
  if (k1 === undefined || typeof setup.input !== 'string')
    throw new Error('Office isolation (c1) returned no k1 or key input');
  const exp = Math.floor(Date.now() / 1000) + 600;
  const claims = JSON.stringify({ key: k1, path: SOURCE, cwd: WORK, exp });
  const probe = await bPosition(lane, aAddress, claims, setup);
  const { kB, tB, kCross } = probe;
  const b = verify('(c2)', probe, EXPECTED_ISOLATION.b, [k1, kB, tB, kCross]);
  crossDiffers(kCross, k1);
  const signArgs = [...NODE, aSignScript(aAddress), claims];
  const signed = await guarded("(c1')", [k1, kB, tB, kCross], () => lane.exec(signArgs));
  const { t, tPublic, k0 } = signed;
  const secrets = [k1, kB, tB, kCross, t, tPublic, k0];
  const sign = verify("(c1')", signed, EXPECTED_ISOLATION.sign, secrets);
  const attackScript = platformAttackScript(aAddress, { ...signed, k1, kB, tB, kCross });
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

/** 18.5 (#440) from the Document Server's own loopback (#624), while A and B edit: A's file recomputes
 * A's registered key, and the Command Service knows A's and B's sessions but none under k0 or under
 * B's own secret over A's key input (kCross, computed in B). */
export async function guessedKeyInfo(
  lane: Pick<OfficeIsolationLane, 'exec'> & { readonly namespaceRead: NamespaceRead },
  b: Pick<OfficeIsolationLane, 'exec'>,
  kA: string,
  kB: string,
  file: string,
) {
  const own = await guarded('(info A)', [kA, kB], () => lane.exec([...NODE, aGuessScript(file)]));
  const { k1, k0, input } = own;
  const known = [kA, kB, k0, k1];
  verify('(info A)', own, { k1: kA }, known);
  if (typeof input !== 'string') throw new Error('Office isolation (info A) returned no key input');
  const argv = [...NODE, bCrossScript(), JSON.stringify(input)];
  const crossed = await guarded('(info B)', known, () => b.exec(argv));
  const { kCross } = crossed;
  const secrets = [...known, kCross];
  verify('(info B)', crossed, {}, secrets);
  crossDiffers(kCross, kA);
  const infoScript = namespaceInfoScript({ k1: kA, kB, k0, kCross });
  const info = await guarded('(info)', secrets, async () =>
    JSON.stringify(await lane.namespaceRead(infoScript)),
  );
  return verify('(info)', info, EXPECTED_INFO, secrets);
}
