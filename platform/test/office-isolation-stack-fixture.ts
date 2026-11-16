import { isDeepStrictEqual } from 'node:util';
import { expect } from 'vitest';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import {
  exchangeFragment,
  KEY_FRAGMENT,
  MINT_FRAGMENT,
  TEXT_JSON_FRAGMENT,
} from './onlyoffice-probe-script.ts';
import { providerCounts, withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveLane } from './sidebar-archive-stack-fixture.ts';

const TARGET_NAME = '隔离目标.docx';
const SOURCE_NAME = '隔离来源.docx';
const TARGET = `${WORK}/${TARGET_NAME}`;
const SOURCE = `${WORK}/${SOURCE_NAME}`;
// `node -e` hands the first extra argument to the script as process.argv[1].
const NODE = ['node', '--input-type=module', '-e'];

/** The archive lane on A, the host docker `run`, A's container `dsh-team-u-<id>` and B's lifecycle. */
export interface OfficeIsolationLane extends ArchiveLane {
  readonly run: DockerOutput;
  readonly instance: string;
  readonly secondEmployee: () => Promise<string>;
  readonly retire: () => Promise<void>;
}

/** The verified observations only; no key or token. */
export interface OfficeIsolationEvidence {
  readonly a: Readonly<Record<string, unknown>>;
  readonly b: Readonly<Record<string, unknown>>;
}

const CONFIG_OK = { status: 200, signed: true };
export const EXPECTED_ISOLATION = {
  a: { config: CONFIG_OK, registry: { k0: false, k1: true } },
  b: {
    connect: { a: 'blocked', b: 'connected' },
    config: CONFIG_OK,
    file: { status: 404, body: 'file not found' },
  },
};

/** Runs as uid 1001 and always exits 0: an error becomes `observed.error`, so a failed exec never
 * echoes argv. The per-instance secret is read from the container environment only. */
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
const register = (
  address: string,
  content: string,
) => `writeFileSync(file, ${JSON.stringify(content)});
const info = statSync(file);
${KEY_FRAGMENT}
${exchangeFragment(address, '127.0.0.1:3080')}
${TEXT_JSON_FRAGMENT}
const config = json(await exchange('GET', '/sidebar/onlyoffice/config?sessionId=t&path=' + encodeURIComponent(file) + '&cwd=' + encodeURIComponent(${JSON.stringify(WORK)})));
observed.config = { status: config.status, signed: config.body?.signed === true };`;

/** (c1) A writes both files, registers k1, then polls the registry (500ms debounce) for up to 5s. */
export const aSetupScript = (address: string): string =>
  script(`writeFileSync(${JSON.stringify(SOURCE)}, 'dsh-team office isolation source');
${register(address, 'dsh-team office isolation target')}
const registry = () => { try { const { entries } = JSON.parse(readFileSync('/data/home/plugins/dsh-sidebar-onlyoffice/registry.json', 'utf8')); return { k0: entries.some((e) => e.key === k0), k1: entries.some((e) => e.key === k1) }; } catch { return { k0: false, k1: false }; } };
const deadline = Date.now() + 5000;
let seen = registry();
while ((!seen.k1 || seen.k0) && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 100)); seen = registry(); }
observed.registry = seen;
observed.k1 = k1;`);

/** (c2) B: no TCP connection to A's :3080 within 3s (timeout, refusal and unreachability all count;
 * A listens there), one to B's own; then B registers k1_B for a same-named target and signs T_B over
 * the claims in argv[1]. T_B on B's file route answers 404: the signature passed, the source is absent. */
export const bProbeScript = (aAddress: string, bAddress: string): string =>
  script(`const probe = (host) => new Promise((resolve) => {
  const socket = connect({ host, port: 3080 });
  const timer = setTimeout(() => { socket.destroy(); resolve('blocked'); }, 3000);
  socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected'); });
  socket.on('error', () => { clearTimeout(timer); resolve('blocked'); });
});
observed.connect = { a: await probe(${JSON.stringify(aAddress)}), b: await probe(${JSON.stringify(bAddress)}) };
${register(bAddress, 'dsh-team office isolation B target')}
${MINT_FRAGMENT}
const tB = mint(JSON.parse(process.argv[1]), secret);
observed.file = text(await exchange('GET', '/sidebar/onlyoffice/file?token=' + encodeURIComponent(tB)));
observed.kB = k1;
observed.tB = tB;`);

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

interface Observed extends Readonly<Record<string, unknown>> {
  readonly error?: string;
  readonly k1?: string;
  readonly kB?: string;
  readonly tB?: string;
}

/** The `expected` keys of `observed`, or a redacted failure carrying the whole observation. */
function verify(label: string, observed: Observed, expected: object, secrets: Secrets) {
  const seen = Object.fromEntries(Object.keys(expected).map((key) => [key, observed[key]]));
  if (observed.error === undefined && isDeepStrictEqual(seen, expected)) return seen;
  const detail = `observed=${JSON.stringify(observed)} expected=${JSON.stringify(expected)}`;
  throw new Error(redactSecrets(`Office isolation ${label} differs: ${detail}`, secrets));
}

/** The container's address on its own bridge, base+2. */
async function instanceAddress(run: DockerOutput, name: string): Promise<string> {
  const id = name.slice('dsh-team-u-'.length);
  const format = '{{json .NetworkSettings.Networks}}';
  const raw = await run(['container', 'inspect', '--format', format, name]);
  const networks = JSON.parse(raw) as Record<string, { IPAddress?: unknown } | undefined>;
  const ip = networks[`dsh-team-net-${id}`]?.IPAddress;
  if (typeof ip !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip))
    throw new Error('Office isolation instance bridge address unavailable');
  return ip;
}

/** B's whole position; `retire` runs in `finally`, so B never outlives it. */
async function bPosition(lane: OfficeIsolationLane, aAddress: string, claims: string) {
  const name = await lane.secondEmployee();
  try {
    const bProbe = bProbeScript(aAddress, await instanceAddress(lane.run, name));
    const stdout = await lane.run(['exec', '--user', '1001', name, ...NODE, bProbe, claims]);
    return JSON.parse(stdout) as Observed;
  } finally {
    await lane.retire();
  }
}

async function officeIsolation(lane: OfficeIsolationLane): Promise<OfficeIsolationEvidence> {
  const before = await providerCounts(lane);
  const aAddress = await instanceAddress(lane.run, lane.instance);
  const setup = JSON.parse(await lane.exec([...NODE, aSetupScript(aAddress)])) as Observed;
  const { k1 } = setup;
  const a = verify('(c1)', setup, EXPECTED_ISOLATION.a, [k1]);
  if (k1 === undefined) throw new Error('Office isolation (c1) returned no k1');
  // Fixed once after (c1); every token of the scenario signs these claims.
  const exp = Math.floor(Date.now() / 1000) + 600;
  const claims = JSON.stringify({ key: k1, path: SOURCE, cwd: WORK, exp });
  const probe = await bPosition(lane, aAddress, claims);
  const b = verify('(c2)', probe, EXPECTED_ISOLATION.b, [k1, probe.kB, probe.tB]);
  expect(await providerCounts(lane), 'No model request or retrieval').toEqual(before);
  return { a, b };
}

/** 18.5 (#440), network layer: B cannot reach A; each instance registers only its own key. */
export const officeIsolationScenario = (
  lane: OfficeIsolationLane,
): Promise<OfficeIsolationEvidence> =>
  withWorkFiles(lane, [TARGET_NAME, SOURCE_NAME], 'Office isolation', () => officeIsolation(lane));
