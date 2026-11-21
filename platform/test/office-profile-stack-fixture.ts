import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { PROFILE_ROWS_READ } from './managed-policy-employee-edit.ts';
import { PROFILE_EDITOR_SERIALIZATION } from './managed-policy-profile.ts';
import {
  guarded,
  instanceAddress,
  NODE,
  redactSecrets,
  register,
  REGISTRY,
  script,
  verify,
} from './office-isolation-stack-fixture.ts';
import type { OfficeIsolationLane } from './office-isolation-stack-fixture.ts';
import { CALLBACK_JS, exchangeJs, JWT_JS, KEY_JS, READ_JS } from './onlyoffice-probe-script.ts';
import { providerCounts, withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveLane } from './sidebar-archive-stack-fixture.ts';

const NAME = '重启登记.docx';
const FILE = `${WORK}/${NAME}`;
/** The rewritten Document Server: the discard port, which (d1) checks has no listener in A. */
export const REWRITTEN_URL = 'http://127.0.0.1:9';

/** A's lane of the isolation scenario plus the administrator restart of A, awaited until ready. */
export interface OfficeProfileLane
  extends ArchiveLane, Pick<OfficeIsolationLane, 'run' | 'instance' | 'platformRead'> {
  readonly restart: () => Promise<void>;
}

/** Status codes, `{ error }`, booleans and the healthcheck body only; no key, secret or URL. */
export type OfficeProfileEvidence = Readonly<
  Record<'register' | 'edit' | 'after' | 'callback' | 'restore', Readonly<Record<string, unknown>>>
>;

export const EXPECTED_PROFILE = {
  register: {
    listener: false,
    config: { status: 200, signed: true },
    registry: { k0: false, k1: true },
  },
  edit: { rewritten: true },
  after: {
    ...{ rewritten: true, health: { status: 200, body: 'true' }, registry: { k1Old: true } },
    ...{ sameInput: true, rekeyed: true },
  },
  callback: { managed: { status: 200, error: 1 }, rewritten: { status: 403, error: 4 } },
  restore: { restored: true, backup: false },
};

/** A `script` statement: `observed.listener` is whether REWRITTEN_URL's port accepts TCP in A. */
export const LISTENER_JS = `observed.listener = await new Promise((resolve) => {
  const probe = connect({ host: '127.0.0.1', port: 9 });
  probe.on('connect', () => { probe.destroy(); resolve(true); });
  probe.on('error', () => resolve(false));
});`;

/** (d1) In A: nothing listens on 127.0.0.1:9; the target is written and k1_old registered. */
export const registerScript = (address: string): string =>
  script(
    `${LISTENER_JS}
${register(address, 'dsh-team office profile target')}
Object.assign(observed, { k0, k1 });`,
    FILE,
  );

/** A uid1001 script on the Web profile; its backup keeps the original bytes, `null` when absent. */
const profileScript = (body: string) => `${PROFILE_ROWS_READ}
import { rmSync } from 'node:fs';
const backup = profile + '.dsh-team-office-profile';
const observed = {};
${body}
process.stdout.write(JSON.stringify(observed));`;

/** (d1) Never over an earlier backup; the row of argv[1] and argv[2] is pushed and the whole file
 * written back in the config editor's dialect, as 17.3 does. */
export const PROFILE_EDIT =
  profileScript(`writeFileSync(backup, JSON.stringify({ bytes: existsSync(profile) ? readFileSync(profile).toString('base64') : null }), { flag: 'wx' });
parsed.push({ id: 'dsh-sidebar-onlyoffice', config: { documentServerUrl: process.argv[1], jwtSecret: process.argv[2] } });
const bytes = dump(parsed, { lineWidth: -1 });
${PROFILE_EDITOR_SERIALIZATION}
writeFileSync(profile, serializedProfile);
const row = load(readFileSync(profile, 'utf8')).at(-1);
observed.rewritten = row?.id === 'dsh-sidebar-onlyoffice' && row.config?.documentServerUrl === process.argv[1] && row.config?.jwtSecret === process.argv[2];`);

/** (d5) No restart: the overlay won anyway, so this only restores the employee's volume. */
export const PROFILE_RESTORE =
  profileScript(`const { bytes } = JSON.parse(readFileSync(backup, 'utf8'));
if (bytes === null) rmSync(profile, { force: true });
else writeFileSync(profile, Buffer.from(bytes, 'base64'));
rmSync(backup);
observed.restored = (existsSync(profile) ? readFileSync(profile).toString('base64') : null) === bytes;
observed.backup = existsSync(backup);`);

/** (d3) argv: the rewritten URL and secret, k1_old and k0. The row survived the restart, the proxy
 * reaches a Document Server, k1_old stays registered and the unchanged input keys anew. */
export const afterScript = (address: string): string =>
  script(
    `const kept = readFileSync('/data/home/profiles/web/cordis.patch.yml', 'utf8');
observed.rewritten = kept.includes(process.argv[1]) && kept.includes(process.argv[2]);
${exchangeJs(address, '127.0.0.1:3080')}
${READ_JS}
const health = async () => { const r = text(await exchange('GET', '/sidebar/onlyoffice/ds/healthcheck')); return { status: r.status, body: r.body.trim() }; };
const until = Date.now() + 10000;
observed.health = await health();
while (observed.health.body !== 'true' && Date.now() < until) { await new Promise((resolve) => setTimeout(resolve, 500)); observed.health = await health(); }
const info = statSync(file);
${KEY_JS}
observed.registry = { k1Old: JSON.parse(readFileSync('${REGISTRY}', 'utf8')).entries.some((e) => e.key === process.argv[3]) };
observed.sameInput = k0 === process.argv[4];
observed.rekeyed = k1 !== undefined && k1 !== process.argv[3];`,
    FILE,
  );

/** (d4) In the platform container: an unregistered `key` under the overlay's JWT secret, then
 * under the `rewritten` one; the key is unknown, so nothing is downloaded or written. */
export const callbackScript = (address: string, key: string, rewritten: string): string =>
  script(`let jwtSecret = process.env.DOCUMENT_SERVER_JWT_SECRET;
${JWT_JS}
${exchangeJs(address, `${address}:3080`)}
${READ_JS}
const url = 'http://${address}:3080/sidebar/onlyoffice/file?token=unregistered';
${CALLBACK_JS}
observed.managed = await callback(${JSON.stringify(key)}, true);
jwtSecret = ${JSON.stringify(rewritten)};
observed.rewritten = await callback(${JSON.stringify(key)}, true);`);

export function officeProfileLine(evidence: OfficeProfileEvidence | undefined) {
  if (evidence === undefined) throw new Error('Office profile evidence missing');
  return evidence;
}

type Secrets = readonly (string | undefined)[];

type Step = keyof typeof EXPECTED_PROFILE;

/** One script in A as uid 1001, checked against `step`'s expectation; failures redact its keys too. */
async function inA(lane: OfficeProfileLane, step: Step, secrets: Secrets, args: string[]) {
  const observed = await guarded(`profile ${step}`, secrets, () => lane.exec([...NODE, ...args]));
  const redacted = [...secrets, observed.k0, observed.k1];
  return { observed, seen: verify(`profile ${step}`, observed, EXPECTED_PROFILE[step], redacted) };
}

/** (d1) edit → restart → (d3) → (d4); `run` holds the rewritten secret, k1_old and k0. */
async function rewrite(lane: OfficeProfileLane, run: readonly string[], secrets: Secrets) {
  const [secret = '', k1 = '', k0 = '', key = ''] = run;
  const { seen: edit } = await inA(lane, 'edit', secrets, [PROFILE_EDIT, REWRITTEN_URL, secret]);
  await lane.restart();
  const address = await instanceAddress(lane.run, lane.instance);
  const { seen: after } = await inA(lane, 'after', secrets, [
    ...[afterScript(address), REWRITTEN_URL],
    ...[secret, k1, k0],
  ]);
  const called = await guarded('profile callback', secrets, async () =>
    JSON.stringify(await lane.platformRead(callbackScript(address, key, secret))),
  );
  return {
    edit,
    after,
    callback: verify('profile callback', called, EXPECTED_PROFILE.callback, secrets),
  };
}

async function officeProfile(lane: OfficeProfileLane): Promise<OfficeProfileEvidence> {
  const before = await providerCounts(lane);
  const [secret, key] = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  const setupArgs = [registerScript(await instanceAddress(lane.run, lane.instance))];
  const { observed, seen } = await inA(lane, 'register', [secret, key], setupArgs);
  const { k0, k1 } = observed;
  const secrets = [secret, key, k0, k1];
  const failures: unknown[] = [];
  let rewritten: Awaited<ReturnType<typeof rewrite>> | undefined;
  let restore: Record<string, unknown> | undefined;
  try {
    rewritten = await rewrite(lane, [secret, k1 ?? '', k0 ?? '', key], secrets);
  } catch (error) {
    failures.push(error);
  }
  try {
    restore = (await inA(lane, 'restore', secrets, [PROFILE_RESTORE])).seen;
  } catch (error) {
    failures.push(error);
  }
  if (rewritten === undefined || restore === undefined) {
    const messages = failures.map((f) => (f instanceof Error ? f.message : String(f)));
    throw new Error(redactSecrets(`Office profile failed: ${messages.join('\n')}`, secrets));
  }
  expect(await providerCounts(lane), 'No model request or retrieval').toEqual(before);
  return { register: seen, ...rewritten, restore };
}

/** 18.5 (d) (#440): the employee's profile rewrite of the ONLYOFFICE row loses to the overlay after
 * a restart, and k1_old survives it under the new per-instance secret; the profile is restored. */
export const officeProfileScenario = (lane: OfficeProfileLane) =>
  withWorkFiles(lane, [NAME], 'Office profile', () => officeProfile(lane));
