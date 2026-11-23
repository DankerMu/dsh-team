import { join } from 'node:path';
import type { FrameLocator } from '@playwright/test';
import { expect } from 'vitest';
import {
  clearingForgottenOnError,
  forgottenDirs,
  forgottenList,
  forgottenPresent,
  forgottenRecord,
  forgottenShape,
  OBSERVE_MS,
  registeredKey,
} from './document-server-forgotten-fixture.ts';
import type { ForgottenKey } from './document-server-forgotten-fixture.ts';
import type { NamespaceRead } from './document-server-net-fixture.ts';
import {
  editorNonce,
  retiringOnError,
  typeAndSave,
  writeArgv,
} from './office-editor-stack-fixture.ts';
import { documentServerReady, openHinted } from './office-hints-stack-fixture.ts';
import {
  guarded,
  instanceAddress,
  NODE,
  officeIsolationScenario,
  verify,
} from './office-isolation-stack-fixture.ts';
import type {
  OfficeIsolationEvidence,
  OfficeIsolationLane,
} from './office-isolation-stack-fixture.ts';
import { NOTICES } from './office-rewrite-stack-fixture.ts';
import { JWT_JS } from './onlyoffice-probe-script.ts';
import { withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import {
  redactSecrets,
  scrub,
  StackWorkbenchFailure,
  workbenchSession,
} from './stack-browser-fixture.ts';

const NAME = '忘记恢复.docx';
const FILE = `${WORK}/${NAME}`;
// The plugin's managed overlay row id; the registry path spells the same plugin out.
const ONLYOFFICE = 'dsh-sidebar-onlyoffice';
// dsProxy's mount: `/sidebar/onlyoffice/ds/<rest>` reaches the Document Server verbatim.
const PROXY_MOUNT = '/sidebar/onlyoffice/ds';
// A released versioned-immutable prefix the DS nginx mints; one of the route variants §55.5 covers.
// The nginx versioned-rewrite rule (ds-docservice.conf:108) and the §55.5 ACL both match a
// three-number version, then a dot or dash, then a word; a tilde separator falls through to
// `location /` and 404s, so use a dash (9.4.0-1).
const VERSION_PREFIX = '/9.4.0-1';

/** One Command Service request target B tries from its own container: an address, port, Host header,
 * request path and whether a forged loopback `X-Forwarded-For` rides along. No secret lives here. */
export interface AttackRow {
  readonly id: '80' | '8000' | 'proxy';
  readonly address: string;
  readonly port: number;
  readonly host: string;
  readonly path: string;
  readonly xff: boolean;
}

/** The +4 Document Server address on a /28 instance bridge: the instance is base+2, the Document
 * Server base+4, so its address is the instance's with the last octet advanced by two. */
export function documentServerAddress(instance: string): string {
  const octets = instance.split('.').map((part) => Number(part));
  const last = octets[3];
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    throw new Error('Office forgotten instance address malformed');
  if (last === undefined || last + 2 > 255)
    throw new Error('Office forgotten +4 address out of range');
  return [octets[0], octets[1], octets[2], last + 2].join('.');
}

// The path variants §55.5 covers on :80 and the plugin proxy: both commands, case, trailing slash,
// the versioned prefix and its encoded `?`/`#` suffixes (nginx matches the decoded path; 55-a's
// ACL closes them). `:8000` (docservice direct) gets only the bare `/command`.
const VARIANTS = [
  '/command',
  '/command/',
  '/Command',
  '/coauthoring/CommandService.ashx',
  '/coauthoring/commandservice.ashx',
  `${VERSION_PREFIX}/command`,
  `${VERSION_PREFIX}/command%3F`,
  `${VERSION_PREFIX}/command%23`,
  `${VERSION_PREFIX}/coauthoring/CommandService.ashx%3F`,
] as const;

/** Every target/path/XFF row B tries: `:80` and the plugin proxy take the whole variant matrix plus
 * one forged-XFF `/command`; `:8000` takes the bare `/command`. `ds` is B's own +4 address. */
export function forgottenRows(instance: string, ds: string): AttackRow[] {
  const rows: AttackRow[] = [];
  const spread = (
    id: AttackRow['id'],
    address: string,
    port: number,
    host: string,
    prefix: string,
  ) => {
    for (const variant of VARIANTS)
      rows.push({ id, address, port, host, path: `${prefix}${variant}`, xff: false });
    rows.push({ id, address, port, host, path: `${prefix}/command`, xff: true });
  };
  spread('80', ds, 80, ds, '');
  rows.push({ id: '8000', address: ds, port: 8000, host: ds, path: '/command', xff: false });
  spread('proxy', instance, 3080, '127.0.0.1:3080', PROXY_MOUNT);
  return rows;
}

/** Shared attack body: with `jwtSecret`, `rows`, `kA` and `control` in scope and `node:http`
 * imported. First a positive control (a GET of the plugin proxy's healthcheck through the same mount
 * and Host as the proxy rows), then `getForgottenList` and `getForgotten` down every row (recorded),
 * then `deleteForgotten` down every row LAST, so A's forgotten copy is only ever removed after the
 * read attempts are already recorded; pre-fix a reached delete does remove it and the recovery check
 * then fails (red), the expected pre-fix outcome. Each result is an outcome token plus booleans —
 * never a key, token or URL. */
const FORGOTTEN_ATTACK_JS = `${JWT_JS}
const attempt = (row, body, method = 'POST') => new Promise((resolve) => {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers = { host: row.host };
  if (payload !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': String(payload.length) });
  if (row.xff) headers['x-forwarded-for'] = '127.0.0.1';
  const req = request({ host: row.address, port: row.port, method, path: row.path, headers }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
  });
  req.on('error', (error) => resolve({ error: error.code || error.message }));
  req.setTimeout(3000, () => { req.destroy(); resolve({ timeout: true }); });
  req.end(payload);
});
const fetchUrl = (raw) => new Promise((resolve) => {
  let target; try { target = new URL(raw); } catch { resolve({ status: 0, bytes: false }); return; }
  const req = request({ host: target.hostname, port: Number(target.port) || 80, method: 'GET', path: target.pathname + target.search }, (res) => {
    let bytes = 0; res.on('data', (chunk) => { bytes += chunk.length; }); res.on('end', () => resolve({ status: res.statusCode, bytes: bytes > 0 }));
  });
  req.on('error', () => resolve({ status: 0, bytes: false }));
  req.setTimeout(3000, () => { req.destroy(); resolve({ status: 0, bytes: false }); });
  req.end();
});
const outcome = (r) => r.timeout ? 'timeout' : r.error ? (r.error === 'ECONNREFUSED' ? 'refused-conn' : 'error') : r.status === 403 ? 'refused' : r.status === 200 ? 'reached' : ('status-' + String(r.status));
const parse = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return undefined; } };
// DS's numeric error for a reached row (0 = authenticated OK, 6 = bad token), else null: it tells
// 55.6 whether B's call was accepted or rejected, which 'reached' alone cannot.
const errorOf = (r, o) => { const data = o === 'reached' ? parse(r) : undefined; return typeof data?.error === 'number' ? data.error : null; };
// The plugin proxy's own fence 403 (dsProxy.ts) is not the Document Server ACL: a fenced row fails.
const fenced = (r) => r.status === 403 && r.body.toString('utf8').includes('cross-site request refused');
const place = (row, r) => ({ id: row.id, path: row.path, xff: !!row.xff, fence: fenced(r) });
const c = await attempt(control, undefined, 'GET');
observed.control = { status: c.status ?? null, body: c.body === undefined ? null : c.body.toString('utf8').trim() };
const list = []; const get = []; const del = [];
for (const row of rows) {
  const r = await attempt(row, { c: 'getForgottenList', token: jwt({ c: 'getForgottenList' }) });
  const o = outcome(r); const keys = o === 'reached' && Array.isArray(parse(r)?.keys) ? parse(r).keys : null;
  list.push({ ...place(row, r), outcome: o, error: errorOf(r, o), length: keys === null ? null : keys.length, listedKa: keys !== null && keys.some((k) => typeof k === 'string' && k.includes(kA)) });
  const g = await attempt(row, { c: 'getForgotten', key: kA, token: jwt({ c: 'getForgotten', key: kA }) });
  const go = outcome(g); const url = go === 'reached' && typeof parse(g)?.url === 'string' ? parse(g).url : undefined;
  get.push({ ...place(row, g), outcome: go, error: errorOf(g, go), gotUrl: url !== undefined, fetched: url === undefined ? null : await fetchUrl(url) });
}
for (const row of rows) {
  const d = await attempt(row, { c: 'deleteForgotten', key: kA, token: jwt({ c: 'deleteForgotten', key: kA }) });
  const dout = outcome(d);
  del.push({ ...place(row, d), outcome: dout, error: errorOf(d, dout), deleted: errorOf(d, dout) === 0 });
}
observed.list = list; observed.get = get; observed.delete = del;`;

/** The plugin proxy's healthcheck from B, through the same mount and Host the proxy rows use. */
export const proxyControl = (instance: string) => ({
  address: instance,
  port: 3080,
  host: '127.0.0.1:3080',
  path: `${PROXY_MOUNT}/healthcheck`,
});

/** B's container script (uid 1001): the JWT comes from B's managed overlay (`/managed/patch.yml`,
 * a JSON array mounted read-only into every instance; `overlay` only for local execution), `rows`,
 * A's key `kA` and the `control` target from argv[1] (a JSON blob; the exec is guarded so a failure
 * never echoes kA). A missing or empty secret THROWS, so a read/sign bug fails loudly instead of
 * masquerading as a DS refusal (§55.6). */
export const bForgottenScript = (
  overlay = '/managed/patch.yml',
): string => `import { request } from 'node:http';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
const parsed = JSON.parse(readFileSync(${JSON.stringify(overlay)}, 'utf8'));
const onlyoffice = Array.isArray(parsed) ? parsed.find((row) => row && row.id === '${ONLYOFFICE}') : undefined;
const jwtSecret = onlyoffice?.config?.jwtSecret;
if (typeof jwtSecret !== 'string' || jwtSecret === '') throw new Error('office forgotten: no jwtSecret in the managed overlay');
const { rows, kA, control } = JSON.parse(process.argv[1]);
const observed = {};
try {
${FORGOTTEN_ATTACK_JS}
} catch (error) { observed.error = error instanceof Error ? error.message : String(error); }
process.stdout.write(JSON.stringify(observed));`;

// `error` and `length` are DS's numeric error and list length when a row reaches the handler, and
// null when it is refused/timed out — null across the board post-fix (nothing reaches DS); `fence`
// marks the plugin proxy's own 403, which must never be what refuses a row.
type Outcome = Readonly<{
  id: string;
  path: string;
  xff: boolean;
  fence: boolean;
  outcome: string;
  error: number | null;
}>;
type ListRow = Outcome & { length: number | null; listedKa: boolean };
type GetRow = Outcome & { gotUrl: boolean; fetched: unknown };
type DeleteRow = Outcome & { deleted: boolean };

/** The §55.5 secure expectation: the proxy healthcheck answers through the same mount (`control`),
 * and every row is refused by the Document Server (`:80`, plugin proxy; never the plugin's fence) or
 * times out (`:8000`), nothing reaching DS (`error`/`length` null), B learning no key, no download
 * URL and deleting nothing. Run pre-fix (§55.6) it is red. */
export function expectedAttack(rows: readonly AttackRow[]) {
  const outcomeOf = (row: AttackRow) => (row.id === '8000' ? 'timeout' : 'refused');
  const place = (row: AttackRow) => ({
    id: row.id,
    path: row.path,
    xff: row.xff,
    fence: false,
    outcome: outcomeOf(row),
    error: null,
  });
  return {
    control: { status: 200, body: 'true' },
    list: rows.map((row): ListRow => ({ ...place(row), length: null, listedKa: false })),
    get: rows.map((row): GetRow => ({ ...place(row), gotUrl: false, fetched: null })),
    delete: rows.map((row): DeleteRow => ({ ...place(row), deleted: false })),
  };
}

/** No key, JWT, token or document bytes: the positive control, the refused attack matrix, the copy
 * still present after the attack, the recovered file state, and what A's key left in the store
 * once the recover session closed (PR #634). */
interface OfficeForgottenEvidence {
  readonly positive: Readonly<Record<string, unknown>>;
  readonly attack: ReturnType<typeof expectedAttack>;
  readonly present: Readonly<Record<string, unknown>>;
  readonly recovered: 'recovered' | 'lost';
  readonly reopenAlert: ReopenAlert;
  readonly residue: Readonly<{ added: number; listed: boolean }>;
}

/** A's lane plus B (started by the editor lane) and the Document Server namespace position. */
type OfficeForgottenLane = OfficeIsolationLane & { readonly namespaceRead: NamespaceRead };

/** Reads the typed text of the DOCX in A's container; a timeout keeps the last-seen state. */
const READ_DOCX = `import json, sys, zipfile
from xml.etree import ElementTree
with zipfile.ZipFile(sys.argv[1]) as archive:
    body = archive.read('word/document.xml')
text = ''.join(el.text or '' for el in ElementTree.fromstring(body).iter() if el.tag.rpartition('}')[2] == 't')
print(json.dumps({'text': text}))`;

// ControlOrMeta+s drives the editor's forcesave (office-editor-stack-fixture's SAVE_KEY).
const SAVE_KEY = 'ControlOrMeta+s';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether A's file holds `nonce`: a nonce on disk means the save succeeded, so the trigger was
 * ineffective (no forgotten copy) rather than refused. */
async function fileHasNonce(lane: OfficeForgottenLane, nonce: string): Promise<boolean> {
  const { text } = JSON.parse(await lane.exec(['python3', '-c', READ_DOCX, FILE])) as {
    text: string;
  };
  return text.includes(nonce);
}

/** Opens A's DOCX, reads the key the plugin actually minted, types the nonce (so the editor is
 * dirty — a dirty editor is never auto-refreshed, so the mtime bump does not re-mint the entry),
 * bumps the mtime, then forcesaves (ControlOrMeta+s): the forcesave flushes the typed change to the
 * Document Server and fails the staleness guard without writing disk. The mtime is deliberately NOT
 * restored here — the restore waits until the asynchronous session-close save has run, else the
 * guard would pass and no copy is stored. Leaves the key in `held` and returns it with whether the
 * edit screenshot was taken.
 */
async function editIntoForgotten(
  lane: OfficeForgottenLane,
  nonce: string,
  directory: string,
  held: ForgottenKey,
): Promise<{ kA: string | null; closed: boolean }> {
  await documentServerReady(lane);
  const names = {
    label: 'office forgotten edit',
    failure: 'office-forgotten-edit-failure',
    // The refused forcesave shows the save-error notice: the guard's message, A's key and path.
    masked: [NOTICES.saveFailed],
  };
  const body: Parameters<typeof workbenchSession>[2] = async (page, shoot) => {
    await openHinted(page, shoot, lane.session, NAME, 'office-forgotten-edit-open');
    held.key = await registeredKey(lane, FILE);
    // Type without the save key: the unsaved edit makes the editor dirty before the mtime bump.
    await typeAndSave(page, 'docx', nonce, lane.session.timeout, undefined, false);
    // A fixed, different mtime trips the plugin's staleness guard; content and size are untouched.
    await lane.exec(['touch', '-m', '-d', '2000-01-01T00:00:00', FILE]);
    // Forcesave now: it flushes the typed change to the Document Server and fails the guard (no disk
    // write), so the session-close save has A's edit to store as forgotten. Bump must precede it.
    await page.keyboard.press(SAVE_KEY);
    await delay(3000);
    await shoot('office-forgotten-edit-typed');
  };
  const editor = await workbenchSession({ ...lane.session, directory }, names, body).catch(
    (error: unknown) => {
      throw sessionFailure('edit', error, { keyRead: held.key !== null }, held.key);
    },
  );
  return { kA: held.key, closed: editor.screenshots.includes('office-forgotten-edit-typed.png') };
}

/** Waits up to `lane.session.timeout` for the platform position to show A's forgotten copy; it
 * appears a few seconds after the browser closes (HTTP-200 `{error:1}` needs no callback retry). */
async function awaitForgotten(lane: OfficeForgottenLane, kA: string) {
  const read = () => forgottenList(lane, '(positive)', kA);
  const deadline = Date.now() + lane.session.timeout;
  let seen = await read();
  while (!forgottenPresent(seen) && Date.now() < deadline) {
    await delay(2000);
    seen = await read();
  }
  return seen;
}

/** What the reopened editor showed: DS 9.4 opens a key whose only copy is in the forgotten store
 * from that copy and raises a modal "opened from the server backup copy" alert (seen as
 * `data-value="-104"`) that blocks the document until dismissed. Fixed UI text, no key. */
type ReopenAlert =
  | { readonly shown: false }
  | {
      readonly shown: true;
      readonly value: string | null;
      readonly text: string;
    };

/** A failed browser session as ONE redacted error without `cause`: vitest prints cause chains and
 * own properties, and the session's console errors and failed requests can carry the Document
 * Server socket path `/doc/<key>/…`. The cause chain's messages, those lists and `scene` are folded
 * into the message instead (as `guarded` does), each part scrubbed of A's key on its own. */
export function sessionFailure(label: string, error: unknown, scene: object, kA: string | null) {
  const clean = (text: string) => scrub(text, [kA ?? undefined]);
  const reasons: string[] = [];
  let current: unknown = error;
  while (current !== undefined && reasons.length < 8) {
    reasons.push(clean(current instanceof Error ? current.message : JSON.stringify(current)));
    current = current instanceof Error ? current.cause : undefined;
  }
  const evidence = error instanceof StackWorkbenchFailure ? error.evidence : undefined;
  const lists = {
    consoleErrors: evidence?.consoleErrors ?? [],
    failedRequests: evidence?.failedRequests ?? [],
  };
  // Every string of the scene and the lists, never the serialized whole.
  const strings = (_key: string, value: unknown) =>
    typeof value === 'string' ? clean(value) : value;
  const detail = JSON.stringify({ ...scene, ...lists }, strings);
  return new Error(`Office forgotten ${label} failed: ${reasons.join(' <- ')}; scene=${detail}`);
}

/** Dismisses the reopen alert inside `editor` (waiting up to 20s for it) and returns what it said. */
async function dismissAlert(
  editor: FrameLocator,
  timeout: number,
  kA: string,
): Promise<ReopenAlert> {
  const alert = editor.locator('.asc-window.modal.alert').first();
  const shown = await alert.waitFor({ state: 'visible', timeout: 20_000 }).then(
    () => true,
    () => false,
  );
  if (!shown) return { shown };
  const value = await alert.getAttribute('data-value', { timeout });
  const text = scrub((await alert.innerText({ timeout })).trim(), [kA]).slice(0, 300);
  await alert.locator('button[result="ok"]').click({ timeout });
  await alert.waitFor({ state: 'hidden', timeout });
  return { shown, value, text };
}

/** Reopens A's DOCX (mtime now restored, so the key is A's original): the Document Server opens it
 * from the forgotten copy and raises its backup-copy alert, which is dismissed; a fresh marker edit
 * then forces a genuine save that writes the reassembled document back. The file holding A's
 * pre-failure nonce (absent before the reopen) can only come from the forgotten copy. */
async function recover(lane: OfficeForgottenLane, nonce: string, directory: string, kA: string) {
  await documentServerReady(lane);
  const names = { label: 'office forgotten recover', failure: 'office-forgotten-recover-failure' };
  const { timeout } = lane.session;
  let alert: ReopenAlert | undefined;
  const loaded = async (editor: FrameLocator) => {
    alert = await dismissAlert(editor, timeout, kA);
  };
  const body: Parameters<typeof workbenchSession>[2] = async (page, shoot) => {
    await openHinted(page, shoot, lane.session, NAME, 'office-forgotten-recover-open');
    await typeAndSave(page, 'docx', editorNonce(), timeout, loaded);
    await shoot('office-forgotten-recover-saved');
  };
  const editor = await workbenchSession({ ...lane.session, directory }, names, body).catch(
    (error: unknown) => {
      throw sessionFailure('recover', error, { alert: alert ?? 'not reached' }, kA);
    },
  );
  const deadline = Date.now() + timeout;
  let held = false;
  while (!held && Date.now() < deadline) {
    held = await fileHasNonce(lane, nonce);
    if (!held) await delay(2000);
  }
  return { editor, alert, recovered: held ? ('recovered' as const) : ('lost' as const) };
}

async function officeForgotten(
  lane: OfficeForgottenLane,
  held: ForgottenKey,
): Promise<OfficeForgottenEvidence> {
  const nonce = editorNonce();
  const directory = join(lane.session.directory, 'office-forgotten');
  await lane.exec(writeArgv(NAME));
  const origin = (await lane.exec(['stat', '-c', '%y', FILE])).trim();
  const beforeDirs = await forgottenDirs(lane);
  // The store before the trigger, A's key not yet known: the anchor's attribution if it fails.
  const beforeShape = await forgottenShape(lane, null, '(shape before)');
  const { kA, closed } = await editIntoForgotten(lane, nonce, directory, held);
  if (kA === null)
    throw new Error('Office forgotten: the plugin minted no key for A (editor open)');
  const positive = await awaitForgotten(lane, kA);
  if (!forgottenPresent(positive)) {
    // Secret-free attribution (§55.6): the forgotten-store delta over the trigger, whether the
    // edit session closed, and whether A's file took the nonce (save succeeded → trigger inert).
    const scene = {
      beforeDirs,
      afterDirs: await forgottenDirs(lane),
      editorClosed: closed,
      fileHasNonce: await fileHasNonce(lane, nonce),
    };
    throw new Error(
      redactSecrets(
        `Office forgotten positive control saw no copy under A's key: positive=${JSON.stringify(positive)} scene=${JSON.stringify(scene)}`,
        [kA],
      ),
    );
  }
  expect(JSON.stringify(positive), 'positive control free of A key').not.toContain(kA);
  // The anchor: the store path is right and A's copy is one directory, named by A's key. The
  // shapes before and after the trigger attribute a mismatch; they carry no key.
  const shapes = { before: beforeShape, after: await forgottenShape(lane, kA, '(shape after)') };
  const shaped = redactSecrets(`one forgotten directory for A key, ${JSON.stringify(shapes)}`, [
    kA,
  ]);
  expect(await forgottenDirs(lane), shaped).toBe(beforeDirs + 1);
  // The copy is stored; restoring the mtime makes the reopen recompute A's original key.
  await lane.exec(['touch', '-m', '-d', origin, FILE]);
  const bInstance = await lane.secondEmployee();
  const bAddress = await instanceAddress(lane.run, bInstance);
  const rows = forgottenRows(bAddress, documentServerAddress(bAddress));
  const argv = JSON.stringify({ rows, kA, control: proxyControl(bAddress) });
  const observed = await guarded('(attack)', [kA], () =>
    lane.run(['exec', '--user', '1001', bInstance, ...NODE, bForgottenScript(), argv]),
  );
  const attack = verify('(attack)', observed, expectedAttack(rows), [
    kA,
  ]) as OfficeForgottenEvidence['attack'];
  const present = await forgottenList(lane, '(present)', kA);
  expect(forgottenPresent(present), "A's forgotten copy still present after B's attack").toBe(true);
  expect(JSON.stringify(present), 'present check free of A key').not.toContain(kA);
  // The nonce is not on disk yet, so a recovered nonce can only come from the forgotten reassembly.
  expect(await fileHasNonce(lane, nonce), "A's file lacks the nonce before reopening").toBe(false);
  const { recovered, alert } = await recover(lane, nonce, directory, kA);
  const seen = `reopen alert ${JSON.stringify(alert)}`;
  expect(recovered, `A recovers its pre-failure edit from the forgotten copy, ${seen}`).toBe(
    'recovered',
  );
  // The recover session's close-time save runs seconds after it closes (PR #634's question).
  await delay(OBSERVE_MS);
  const { cleared, ...residue } = await forgottenRecord(lane, kA, beforeDirs, '(residue)');
  const left = `residue ${JSON.stringify(residue)}`;
  expect(cleared, `forgotten store back at its baseline, A key unlisted, ${left}`).toBe(true);
  return { positive, attack, present, recovered, reopenAlert: alert ?? { shown: false }, residue };
}

/**
 * #624 / §55.5, then 18.5's isolation lane (which retires B): A edits a DOCX whose save then fails,
 * leaving A's only copy of the edit in the Document Server's forgotten store. From B's own
 * container every Command Service path — the +4 bridge on :80 and :8000, and the plugin proxy — is
 * refused across the route variants, encoded suffixes and a forged X-Forwarded-For, so B lists no
 * key, downloads nothing and deletes nothing; A's copy survives and A recovers its edit on reopen.
 * The forgotten evidence rides on the isolation line as `forgotten`. A forgotten failure retires B,
 * and once A's key was read, clears A's copy after `settle`.
 */
export async function officeIsolationWithForgotten(
  lane: OfficeForgottenLane,
  settle = OBSERVE_MS,
): Promise<OfficeIsolationEvidence & { readonly forgotten: OfficeForgottenEvidence }> {
  const cleared = (held: ForgottenKey) => officeForgotten(lane, held);
  const forgotten = await retiringOnError(
    () =>
      withWorkFiles(lane, [NAME], 'Office forgotten', () =>
        clearingForgottenOnError(lane, '(forgotten cleanup)', cleared, settle),
      ),
    lane.retire,
    'Office forgotten lane and retiring B failed',
  );
  return { ...(await officeIsolationScenario(lane)), forgotten };
}
