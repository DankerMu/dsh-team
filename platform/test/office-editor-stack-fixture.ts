import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Page, Response } from '@playwright/test';
import { expect } from 'vitest';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import {
  DOCUMENT_SERVER,
  docxCommand,
  documentServerReady,
  hintsFrame,
  openHinted,
  serviceWorkerRefused,
  untilSeen,
} from './office-hints-stack-fixture.ts';
import { redactSecrets, REGISTRY } from './office-isolation-stack-fixture.ts';
import { withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { converseInWorkbench, until, workbenchSession } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence } from './stack-browser-fixture.ts';

// The pinned Document Server's own blank templates (§51.4); they never enter the repository.
const TEMPLATES = '/var/www/onlyoffice/documentserver/document-templates/new/en-US/new';
const EXTS = ['docx', 'xlsx', 'pptx'] as const;
type Ext = (typeof EXTS)[number];
const fileName = (ext: Ext) => `编辑写回.${ext}`;
const PARAGRAPH = '编辑写回探针。';
/** The docx gets the one paragraph, an xlsx or pptx a template's bytes as base64. */
export const writeArgv = (name: string, base64?: string) =>
  docxCommand(name, ...(base64 === undefined ? [PARAGRAPH] : ['--base64', base64]));
// Adjustable without touching an assertion: §48's one visible editor iframe, its document area, save.
const editorFrame = (ext: Ext) =>
  `${hintsFrame(fileName(ext))} iframe[src*="/sidebar/onlyoffice/ds/"]`;
const EDITOR_AREA = '#editor_sdk';
// DS 9.4 app:face drops #loading-mask and masks input with .asc-loadmask until the content is ready.
const EDITOR_READY = 'body:not(:has(#loading-mask, .asc-loadmask))';
const SAVE_KEY = 'ControlOrMeta+s';
// Where the document area is clicked, as fractions of its box, and the keys after the nonce: the
// centre puts the DOCX caret in the text and selects an XLSX cell, which Enter commits; the PPTX
// point is meant for slide 1's title placeholder (§51.4, measured on the first stack run).
const EDITING: Record<Ext, { at: readonly [number, number]; keys: readonly string[] }> = {
  docx: { at: [0.5, 0.5], keys: [SAVE_KEY] },
  xlsx: { at: [0.5, 0.5], keys: ['Enter', SAVE_KEY] },
  pptx: { at: [0.5, 0.4], keys: [SAVE_KEY] },
};
/** The read-back turn's requests: the bash call, the tool-result round and the title request. */
const READ_BACK_REQUESTS = 3;

/** The typed nonce: uppercase hex, so the editor's autocorrect leaves its first letter alone. */
export const NONCE_PATTERN = /EDITOR[0-9A-F]{32}/;
export const editorNonce = () => `EDITOR${randomUUID().replaceAll('-', '').toUpperCase()}`;

// Python stdlib, no single quote (see below). One path: the text of the elements named t in each
// XML part, joined per part, with size and digest. Several: only the nonces all of them hold.
export const READER = `import hashlib, json, re, sys, zipfile
from xml.etree import ElementTree
def read(path):
    data = open(path, "rb").read()
    with zipfile.ZipFile(path) as archive:
        parts = {name: ElementTree.fromstring(archive.read(name)) for name in archive.namelist() if name.endswith((".xml", ".rels"))}
    texts = {name: "".join(el.text or "" for el in root.iter() if el.tag.rpartition("}")[2] == "t") for name, root in parts.items()}
    return {"texts": texts, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
if len(sys.argv) == 2:
    print(json.dumps(read(sys.argv[1])))
else:
    found = [{nonce for text in read(path)["texts"].values() for nonce in re.findall("${NONCE_PATTERN.source}", text)} for path in sys.argv[1:]]
    common = sorted(set.intersection(*found))
    if common:
        print("\\n".join(common))`;
const inWork = (ext: Ext) => `${WORK}/${fileName(ext)}`;
const PYTHON = ['python3', '-c', READER];
const readWork = async ({ exec }: ArchiveLane, ext: Ext) =>
  JSON.parse(await exec([...PYTHON, inWork(ext)])) as OfficeRead;
const READER_ARGV = [...PYTHON, ...EXTS.map(inWork)];
/** The Agent's bash read-back: the reader over all three files, each word single-quoted. */
export const READ_BACK_COMMAND = READER_ARGV.map((word) => {
  if (word.includes("'")) throw new Error('Read-back word holds a single quote');
  return `'${word}'`;
}).join(' ');

type Digest = Pick<ArchiveEntry, 'size' | 'sha256'>;
const digest = ({ size, sha256 }: Digest) => ({ size, sha256 });
interface OfficeRead extends Digest {
  readonly texts: Readonly<Record<string, string>>;
}
const holds = (texts: OfficeRead['texts'], nonce: string) =>
  Object.values(texts).some((text) => text.includes(nonce));

/** Saved once the bytes differ from `original` and a part's text holds the typed nonce. */
export function writeBackState(original: string, read: OfficeRead, nonce: string) {
  if (read.sha256 === original) return 'unchanged';
  return holds(read.texts, nonce) ? 'saved' : 'changed-without-nonce';
}

/** A same-name file after both sessions: `own` holds its own side's nonce and not the other's. */
export function sameNameState(read: OfficeRead, own: string, other: string) {
  if (holds(read.texts, other)) return 'crossed';
  return holds(read.texts, own) ? 'own' : 'missing';
}

const ONCE = { readBacks: 1, readBackHits: 1, requests: READ_BACK_REQUESTS };
export const EXPECTED_DELTAS = { ...ONCE, searches: 0, delegations: 0 };
const COUNTERS = Object.keys(EXPECTED_DELTAS);

/** Each counter's delta from `before` to `after`; a counter missing from either yields NaN. */
export const providerDeltas = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  Object.fromEntries(COUNTERS.map((key) => [key, Number(after[key]) - Number(before[key])]));

interface FileDigests {
  readonly file: string;
  readonly before: Digest;
  readonly after: Digest;
}
/** No nonce, marker or key: digests, counter deltas and every browser session. */
export interface OfficeEditorEvidence {
  readonly files: readonly FileDigests[];
  readonly saved: true;
  readonly provider: Record<string, number>;
  readonly editors: Readonly<Record<string, StackBrowserEvidence>>;
  readonly readBack: StackBrowserEvidence;
  /** B's same-name DOCX, edited while A's was open (51.6). */
  readonly sameName: {
    readonly b: FileDigests;
    readonly editor: StackBrowserEvidence;
    readonly distinctKeys: boolean;
    readonly crossed: boolean;
  };
}

const WORKER_403 = /^403 \/sidebar\/onlyoffice\/ds\/[^/]+\/document_editor_service_worker\.js$/;
// DS startup's pluginsmanager installs the marketplace AI plugin, whose zh-ZH helper translation is
// missing upstream; offline production never installs it (§51.2, user decision 2026-11-16).
const AI_PLUGIN_404 =
  /^404 \/sidebar\/onlyoffice\/ds\/[^/]+\/sdkjs-plugins\/%7B9DC93CDB-B576-4F0C-B55E-FCC9C48DD007%7D\/translations\/helpers\/zh-ZH\.json$/;
const NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)';

/** openHinted's wait in the editing session: §48's two refusals, the AI plugin 404 text aside. */
const refusals = (errors: readonly string[]) => errors.filter((error) => error !== NOT_FOUND);
export const editorRefused = (errors: readonly string[], base: string) =>
  serviceWorkerRefused(refusals(errors), base);

/** The editing session's console errors and `status path` responses >= 400: §48's ServiceWorker
 * refusal plus at most one AI plugin 404 and, only with that response, its console text. */
export function editorErrorsAllowed(errors: readonly string[], responses: string[], base: string) {
  const plugin = responses.filter((response) => AI_PLUGIN_404.test(response)).length;
  const [worker, ...others] = responses.filter((response) => !AI_PLUGIN_404.test(response));
  const texts = errors.length - refusals(errors).length;
  const workerOnly = others.length === 0 && WORKER_403.test(worker ?? '');
  return workerOnly && plugin <= 1 && texts <= plugin && editorRefused(errors, base);
}

const LISTS = ['consoleErrors', 'pageErrors', 'failedRequests', 'externalRequests'] as const;
const counted = (browser: StackBrowserEvidence) => ({
  screenshots: browser.screenshots,
  ...Object.fromEntries(LISTS.map((key) => [key, browser[key].length])),
});

/** The stack evidence line: each session by its screenshots and error counts. */
export function officeEditorLine(evidence: OfficeEditorEvidence | undefined) {
  if (evidence === undefined) throw new Error('Office editor evidence missing');
  const { editors, readBack, ...rest } = evidence;
  const sessions = Object.entries(editors).map(([ext, editor]) => [ext, counted(editor)] as const);
  const sameName = { ...rest.sameName, editor: counted(rest.sameName.editor) };
  return { ...rest, sameName, editors: Object.fromEntries(sessions), readBack: counted(readBack) };
}

/** A's lane plus the provider's own reply and read-back script, the values it was configured with,
 * and B's: `secondEmployee` starts B once and yields its instance, `retire` disables it. */
export type OfficeEditorLane = ArchiveLane & {
  readonly run: DockerOutput;
  readonly reply: string;
  readonly readBack: Readonly<Record<'marker' | 'command' | 'nonce', string>>;
  readonly secondEmployee: () => Promise<string>;
  readonly secondEmail: string;
  readonly retire: () => Promise<void>;
};

// The element holding each frame's focus, by tag and id; frame URLs lose their query (keys).
const FOCUS = `(() => { const el = document.activeElement; return el && el.tagName + '#' + el.id; })()`;
const frameChain = (page: Page) =>
  Promise.all(
    page.frames().map(async (frame) => ({
      path: frame.url().split(/[?#]/)[0],
      focus: await frame.evaluate<unknown>(FOCUS).catch(() => 'unreadable'),
    })),
  );

const passed = () => Promise.resolve();

/** Clicks the document area through the iframe once `loaded` passed, types the nonce and saves. */
async function typeAndSave(page: Page, ext: Ext, nonce: string, timeout: number, loaded = passed) {
  const { at, keys } = EDITING[ext];
  try {
    const editor = page.locator(editorFrame(ext)).visible().contentFrame();
    const area = editor.locator(EDITOR_AREA);
    await area.waitFor({ timeout });
    await editor.locator(EDITOR_READY).waitFor({ state: 'attached', timeout });
    await loaded();
    const box = await area.boundingBox({ timeout });
    if (box === null) throw new Error('Office editor area has no box');
    await area.click({ position: { x: box.width * at[0], y: box.height * at[1] }, timeout });
    await page.keyboard.type(nonce);
    for (const key of keys) await page.keyboard.press(key);
  } catch (cause) {
    const frames = JSON.stringify(await frameChain(page));
    throw new Error(`Office editor typing or saving failed, frames ${frames}`, { cause });
  }
}

/** Polls the instance's file for at most 120s; a timeout names the state it ended in. */
async function writtenBack(read: () => Promise<OfficeRead>, original: string, nonce: string) {
  let last: OfficeRead | undefined;
  let state: ReturnType<typeof writeBackState> = 'unchanged';
  const saved = async () => {
    last = await read();
    state = writeBackState(original, last, nonce);
    return state === 'saved';
  };
  const seen = () => ({ state, texts: last?.texts });
  await untilSeen(seen, saved, 120_000, 'Office editor write-back not saved, ended');
  if (last === undefined) throw new Error('Office editor write-back never read');
  return last;
}

/** Two sides' rendezvous: `arrive` resolves once both arrived and `whenBoth`, run once, passed;
 * a lone side rejects after `timeout`; after `fail` every waiting and later arrival rejects at once. */
export function gate(sides: readonly string[], timeout: number, whenBoth = passed) {
  const arrived = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let open = true;
  let close: (error?: Error) => void = () => undefined;
  const released = new Promise<void>((resolve, reject) => {
    close = (error) => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
  });
  released.catch(() => undefined);
  const timedOut = () => `after ${String(timeout)}ms, only ${[...arrived].join(', ')} arrived`;
  const arrive = (side: string) => {
    if (!open || arrived.has(side)) return released;
    arrived.add(side);
    if (arrived.size < sides.length) {
      timer ??= setTimeout(() => {
        close(new Error(`Office editor gate timed out ${timedOut()}`));
      }, timeout);
    } else {
      clearTimeout(timer);
      whenBoth().then(
        () => {
          close();
        },
        (error: unknown) => {
          close(error instanceof Error ? error : new Error(String(error)));
        },
      );
    }
    return released;
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    close(new Error(`Office editor gate closed: ${message}`, { cause: error }));
  };
  return { arrive, fail };
}

/** `body`'s result; when it fails, `retire` runs and the failure leaves first. */
export async function retiringOnError<T>(body: () => Promise<T>, retire: () => Promise<void>) {
  try {
    return await body();
  } catch (error) {
    await retire().catch((failure: unknown) => {
      throw new AggregateError([error, failure], 'Office editor lane and retiring B failed');
    });
    throw error;
  }
}

/** One side's nonce and its arrivals at the two shared gates. */
interface Meeting {
  readonly nonce: string;
  readonly loaded: () => Promise<void>;
  readonly saved: () => Promise<void>;
}

/** One browser session opens, types, saves and sees the write-back; the file is read once more. */
async function editAndSave(lane: OfficeEditorLane, ext: Ext, directory: string, meeting?: Meeting) {
  const { exec, run, session } = lane;
  const nonce = meeting?.nonce ?? lane.readBack.nonce;
  const template = ['exec', DOCUMENT_SERVER, 'base64', '-w0', `${TEMPLATES}.${ext}`];
  const base64 = ext === 'docx' ? undefined : (await run(template)).trim();
  const written = JSON.parse(await exec(writeArgv(fileName(ext), base64))) as ArchiveEntry;
  const read = () => readWork(lane, ext);
  const { texts, sha256 } = await read();
  const typed = holds(texts, nonce);
  expect({ sha256, typed }, ext).toEqual({ sha256: written.sha256, typed: false });
  if (ext === 'docx') expect(texts['word/document.xml'], 'DOCX text').toBe(PARAGRAPH);
  await documentServerReady(lane);
  const shot = `office-editor-${ext}`;
  const names = { label: `office editor ${ext}`, failure: `${shot}-failure` };
  let saved: OfficeRead | undefined;
  const body: Parameters<typeof workbenchSession>[2] = async (page, shoot) => {
    await openHinted(page, shoot, session, fileName(ext), `${shot}-open`, editorRefused);
    await typeAndSave(page, ext, nonce, session.timeout, meeting?.loaded);
    saved = await writtenBack(read, written.sha256, nonce);
    await meeting?.saved();
    await shoot(`${shot}-saved`);
  };
  // Status and path of every failed response; the query and hash may carry keys.
  const failed: string[] = [];
  const record = (response: Response) => {
    const status = response.status();
    if (status >= 400) failed.push(`${String(status)} ${new URL(response.url()).pathname}`);
  };
  const editor = await workbenchSession({ ...session, directory }, names, body, undefined, record);
  const seen = `consoleErrors, responses ${JSON.stringify([editor.consoleErrors, failed])}`;
  expect(editorErrorsAllowed(editor.consoleErrors, failed, session.base), seen).toBe(true);
  expect(counted(editor), seen).toMatchObject({
    screenshots: [`${shot}-open.png`, `${shot}-saved.png`],
    ...{ pageErrors: 0, failedRequests: 0, externalRequests: 0 },
  });
  // A late status 2 may rewrite the bytes, never without the nonce.
  const after = await read();
  const closed = writeBackState(written.sha256, after, nonce);
  expect(closed, `Office editor ${ext} file after the browser closed`).toBe('saved');
  if (saved === undefined) throw new Error('Office editor save not observed');
  return { editor, written, after };
}

type Edited = Awaited<ReturnType<typeof editAndSave>>;
const SIDES = ['A', 'B'] as const;
// The registry's keys for one path (plugin 0.2.0: `{ version, entries: [{ key, entry: { path } }] }`);
// a registry not yet written, or half written, holds none yet.
const KEYS = `import json, sys
try:
    entries = json.load(open(sys.argv[1]))["entries"]
except (OSError, ValueError):
    entries = []
print(json.dumps([e["key"] for e in entries if (e.get("entry") or {}).get("path") == sys.argv[2]]))`;
const keysOf = (output: string) => {
  try {
    return JSON.parse(output) as string[];
  } catch {
    return [];
  }
};

/** Polls both registries for 5s until each has one entry for the DOCX; the keys stay in memory. */
async function distinctKeys(lanes: readonly ArchiveLane[], met: { distinct: boolean }) {
  const argv = ['python3', '-c', KEYS, REGISTRY, inWork('docx')];
  let keys: string[][] = [];
  const one = async () => {
    keys = await Promise.all(lanes.map(async ({ exec }) => keysOf(await exec(argv))));
    return keys.every((side) => side.length === 1);
  };
  await until(one, 5_000, 'registry entries').catch((error: unknown) => {
    const counts = JSON.stringify(
      Object.fromEntries(keys.map((side, i) => [SIDES[i], side.length])),
    );
    const message = error instanceof Error ? error.message : String(error);
    const failed = `Office editor registry entries per side ${counts}: ${message}`;
    throw new Error(redactSecrets(failed, keys.flat()));
  });
  const [kA, kB] = keys.map(([key]) => key);
  expect(kA !== kB, 'A and B edit the same-name DOCX under distinct keys').toBe(true);
  met.distinct = kA !== kB;
}

/** A's and B's same-name DOCX edited at once, each with its own nonce, then read once more. */
async function sameNameDocx(lane: OfficeEditorLane, instance: string, directory: string) {
  const b: OfficeEditorLane = {
    ...lane,
    session: { ...lane.session, email: lane.secondEmail },
    exec: (args) => lane.run(['exec', '--user', '1001', instance, ...args]),
  };
  const [nonceA, nonceB] = [lane.readBack.nonce, editorNonce()];
  const met = { distinct: false, A: false, B: false };
  const loaded = gate(SIDES, lane.session.timeout, () => distinctKeys([lane, b], met));
  const saved = gate(SIDES, 120_000);
  const edit = (side: OfficeEditorLane, name: 'A' | 'B', nonce: string, where: string) => {
    const saving = () => saved.arrive(name).then(() => void (met[name] = true));
    const meeting = { nonce, loaded: () => loaded.arrive(name), saved: saving };
    return editAndSave(side, 'docx', where, meeting).catch((error: unknown) => {
      loaded.fail(error);
      saved.fail(error);
      throw error;
    });
  };
  return withWorkFiles(b, [fileName('docx')], 'Office editor B', async () => {
    const [a, other] = await Promise.allSettled([
      edit(lane, 'A', nonceA, directory),
      edit(b, 'B', nonceB, join(directory, 'b')),
    ]);
    if (a.status === 'rejected' || other.status === 'rejected') {
      const failures = [a, other].flatMap((side) =>
        side.status === 'rejected' ? [side.reason as unknown] : [],
      );
      throw new AggregateError(failures, 'Office editor same-name DOCX failed');
    }
    const [aAfter, bAfter] = [await readWork(lane, 'docx'), await readWork(b, 'docx')];
    const states = [sameNameState(aAfter, nonceA, nonceB), sameNameState(bAfter, nonceB, nonceA)];
    expect(states, 'A and B same-name DOCX after both browsers closed').toEqual(['own', 'own']);
    expect(met, 'A and B met at both gates').toEqual({ distinct: true, A: true, B: true });
    const { written, editor } = other.value;
    const file = { file: fileName('docx'), before: digest(written), after: digest(bAfter) };
    const crossed = states.includes('crossed');
    const sameName = { b: file, editor, distinctKeys: met.distinct, crossed };
    return { a: a.value, sameName };
  });
}

/** The Agent's turn, done once the provider counted the hit and the turn's requests. */
function agentReadBack(lane: OfficeEditorLane, start: Record<string, unknown>, directory: string) {
  let health = start;
  const served = async () => {
    health = await lane.provider();
    const hit = Number(health.readBackHits) >= Number(start.readBackHits) + 1;
    return hit && Number(health.requests) >= Number(start.requests) + READ_BACK_REQUESTS;
  };
  const message = 'Office editor read-back turn not complete, provider';
  return converseInWorkbench({
    ...{ ...lane.session, directory, reply: lane.reply },
    message: `${lane.readBack.marker} 请读取编辑后的文档`,
    turnComplete: () => untilSeen(() => health, served, lane.session.timeout, message),
  });
}

async function officeEditor(lane: OfficeEditorLane): Promise<OfficeEditorEvidence> {
  const instance = await lane.secondEmployee();
  const start = await lane.provider();
  expect([start.readBacks, start.readBackHits], 'Read-back script configured').toEqual([0, 0]);
  const { command, nonce } = lane.readBack;
  expect(nonce, 'Lane nonce').toMatch(new RegExp(`^${NONCE_PATTERN.source}$`));
  expect(command, 'Read-back command holds a nonce').not.toMatch(NONCE_PATTERN);
  const directory = join(lane.session.directory, 'office-editor');
  const files: FileDigests[] = [];
  const editors: Record<string, StackBrowserEvidence> = {};
  const recorded = (ext: Ext, { editor, written, after }: Edited) => {
    files.push({ file: fileName(ext), before: digest(written), after: digest(after) });
    editors[ext] = editor;
  };
  const { a, sameName } = await sameNameDocx(lane, instance, directory);
  recorded('docx', a);
  for (const ext of EXTS.slice(1)) recorded(ext, await editAndSave(lane, ext, directory));
  const readBack = await agentReadBack(lane, start, directory);
  expect(counted(readBack)).toEqual({
    screenshots: ['login.png', 'workbench.png', 'reply.png'],
    ...{ consoleErrors: 0, pageErrors: 0, failedRequests: 0, externalRequests: 0 },
  });
  const provider = providerDeltas(start, await lane.provider());
  expect(provider, 'Provider deltas over the Office editor lane').toEqual(EXPECTED_DELTAS);
  return { files, saved: true, provider, editors, readBack, sameName };
}

/**
 * 18.5 (#440): A types into 编辑写回.docx, .xlsx and .pptx in ONLYOFFICE and saves each, B into its
 * same-name DOCX at the same time; each file holds only its own side's text, and the Agent's `bash`
 * read-back sees A's in all three. A failure retires B; success leaves B to the isolation lane.
 */
export const officeEditorScenario = (lane: OfficeEditorLane): Promise<OfficeEditorEvidence> =>
  retiringOnError(
    () => withWorkFiles(lane, EXTS.map(fileName), 'Office editor', () => officeEditor(lane)),
    lane.retire,
  );
