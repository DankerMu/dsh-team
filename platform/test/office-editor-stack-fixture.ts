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
import { withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { converseInWorkbench, workbenchSession } from './stack-browser-fixture.ts';
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
const LOADING_MASK = '#loading-mask'; // Removed by DS 9.4 hidePreloader() on onDocumentContentReady.
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
const READER_ARGV = [...PYTHON, ...EXTS.map(inWork)];
/** The Agent's bash read-back: the reader over all three files, each word single-quoted. */
export const READ_BACK_COMMAND = READER_ARGV.map((word) => {
  if (word.includes("'")) throw new Error('Read-back word holds a single quote');
  return `'${word}'`;
}).join(' ');

type Digest = Pick<ArchiveEntry, 'size' | 'sha256'>;
interface OfficeRead extends Digest {
  readonly texts: Readonly<Record<string, string>>;
}

/** Saved once the bytes differ from `original` and a part's text holds the typed nonce. */
export function writeBackState(original: string, read: OfficeRead, nonce: string) {
  if (read.sha256 === original) return 'unchanged';
  const typed = Object.values(read.texts).some((text) => text.includes(nonce));
  return typed ? 'saved' : 'changed-without-nonce';
}

const ONCE = { readBacks: 1, readBackHits: 1, requests: READ_BACK_REQUESTS };
export const EXPECTED_DELTAS = { ...ONCE, searches: 0, delegations: 0 };
const COUNTERS = Object.keys(EXPECTED_DELTAS);

/** Each counter's delta from `before` to `after`; a counter missing from either yields NaN. */
export const providerDeltas = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  Object.fromEntries(COUNTERS.map((key) => [key, Number(after[key]) - Number(before[key])]));

/** No nonce, marker or key: digests, counter deltas and every browser session. */
export interface OfficeEditorEvidence {
  readonly files: readonly { file: string; before: Digest; after: Digest }[];
  readonly saved: true;
  readonly provider: Record<string, number>;
  readonly editors: Readonly<Record<string, StackBrowserEvidence>>;
  readonly readBack: StackBrowserEvidence;
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
  return { ...rest, editors: Object.fromEntries(sessions), readBack: counted(readBack) };
}

/** A's lane plus the provider's own reply and read-back script, the values it was configured with. */
export type OfficeEditorLane = ArchiveLane & {
  readonly run: DockerOutput;
  readonly reply: string;
  readonly readBack: Readonly<Record<'marker' | 'command' | 'nonce', string>>;
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

/** Clicks the document area through the iframe, types the nonce and saves. */
async function typeAndSave(page: Page, ext: Ext, nonce: string, timeout: number) {
  const { at, keys } = EDITING[ext];
  try {
    const editor = page.locator(editorFrame(ext)).visible().contentFrame();
    const area = editor.locator(EDITOR_AREA);
    await area.waitFor({ timeout });
    await editor.locator(LOADING_MASK).waitFor({ state: 'hidden', timeout });
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

/** One browser session opens, types, saves and sees the write-back; the file is read once more. */
async function editAndSave(lane: OfficeEditorLane, ext: Ext, directory: string) {
  const { exec, run, session, readBack } = lane;
  const template = ['exec', DOCUMENT_SERVER, 'base64', '-w0', `${TEMPLATES}.${ext}`];
  const base64 = ext === 'docx' ? undefined : (await run(template)).trim();
  const written = JSON.parse(await exec(writeArgv(fileName(ext), base64))) as ArchiveEntry;
  const read = async () => JSON.parse(await exec([...PYTHON, inWork(ext)])) as OfficeRead;
  const { texts, sha256 } = await read();
  const typed = Object.values(texts).some((text) => text.includes(readBack.nonce));
  expect({ sha256, typed }, ext).toEqual({ sha256: written.sha256, typed: false });
  if (ext === 'docx') expect(texts['word/document.xml'], 'DOCX text').toBe(PARAGRAPH);
  await documentServerReady(lane);
  const shot = `office-editor-${ext}`;
  const names = { label: `office editor ${ext}`, failure: `${shot}-failure` };
  let saved: OfficeRead | undefined;
  const body: Parameters<typeof workbenchSession>[2] = async (page, shoot) => {
    await openHinted(page, shoot, session, fileName(ext), `${shot}-open`, editorRefused);
    await typeAndSave(page, ext, readBack.nonce, session.timeout);
    saved = await writtenBack(read, written.sha256, readBack.nonce);
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
  const closed = writeBackState(written.sha256, after, readBack.nonce);
  expect(closed, `Office editor ${ext} file after the browser closed`).toBe('saved');
  if (saved === undefined) throw new Error('Office editor save not observed');
  return { editor, written, after };
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
  const start = await lane.provider();
  expect([start.readBacks, start.readBackHits], 'Read-back script configured').toEqual([0, 0]);
  const { command, nonce } = lane.readBack;
  expect(nonce, 'Lane nonce').toMatch(new RegExp(`^${NONCE_PATTERN.source}$`));
  expect(command, 'Read-back command holds a nonce').not.toMatch(NONCE_PATTERN);
  const directory = join(lane.session.directory, 'office-editor');
  const digest = ({ size, sha256 }: Digest) => ({ size, sha256 });
  const files: OfficeEditorEvidence['files'][number][] = [];
  const editors: Record<string, StackBrowserEvidence> = {};
  for (const ext of EXTS) {
    const { editor, written, after } = await editAndSave(lane, ext, directory);
    files.push({ file: fileName(ext), before: digest(written), after: digest(after) });
    editors[ext] = editor;
  }
  const readBack = await agentReadBack(lane, start, directory);
  expect(counted(readBack)).toEqual({
    screenshots: ['login.png', 'workbench.png', 'reply.png'],
    ...{ consoleErrors: 0, pageErrors: 0, failedRequests: 0, externalRequests: 0 },
  });
  const provider = providerDeltas(start, await lane.provider());
  expect(provider, 'Provider deltas over the Office editor lane').toEqual(EXPECTED_DELTAS);
  return { files, saved: true, provider, editors, readBack };
}

/**
 * 18.5 (#440): A types into 编辑写回.docx, .xlsx and .pptx in ONLYOFFICE and saves each; the
 * instance's files then hold the typed text and the Agent's `bash` read-back sees it in all three.
 */
export const officeEditorScenario = (lane: OfficeEditorLane): Promise<OfficeEditorEvidence> =>
  withWorkFiles(lane, EXTS.map(fileName), 'Office editor', () => officeEditor(lane));
