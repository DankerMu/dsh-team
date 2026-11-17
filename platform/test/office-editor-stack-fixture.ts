import { join } from 'node:path';
import type { Page, Response } from '@playwright/test';
import { expect } from 'vitest';
import {
  docxCommand,
  documentServerReady,
  openHinted,
  serviceWorkerRefused,
  untilSeen,
} from './office-hints-stack-fixture.ts';
import { withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { converseInWorkbench, workbenchSession } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence } from './stack-browser-fixture.ts';

const NAME = '编辑写回.docx';
const PARAGRAPH = '编辑写回探针。';
export const WRITE_ARGV = docxCommand(NAME, PARAGRAPH);
// Adjustable without touching an assertion: §48's one visible editor iframe, its document area, save.
const EDITOR_FRAME = '[data-dsh-team-office-hints="docx"] iframe[src*="/sidebar/onlyoffice/ds/"]';
const EDITOR_AREA = '#editor_sdk';
const SAVE_KEY = 'ControlOrMeta+s';
/** The read-back turn's requests: the bash call, the tool-result round and the title request. */
const READ_BACK_REQUESTS = 3;

// python-docx from the image prints every paragraph of argv[1]; no single quote, see below.
export const READER = `import hashlib, json, sys
from docx import Document
data = open(sys.argv[1], "rb").read()
paragraphs = [paragraph.text for paragraph in Document(sys.argv[1]).paragraphs]
print(json.dumps({"paragraphs": paragraphs, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}))`;
export const READER_ARGV = ['python3', '-c', READER, `${WORK}/${NAME}`];
/** The Agent's bash read-back: the same argv, each word single-quoted; never the nonce. */
export const READ_BACK_COMMAND = READER_ARGV.map((word) => {
  if (word.includes("'")) throw new Error('Read-back word holds a single quote');
  return `'${word}'`;
}).join(' ');

type Digest = Pick<ArchiveEntry, 'size' | 'sha256'>;
interface DocxRead extends Digest {
  readonly paragraphs: readonly string[];
}

/** Saved once the bytes differ from `original` and a paragraph holds the typed nonce. */
export function writeBackState(original: string, read: DocxRead, nonce: string) {
  if (read.sha256 === original) return 'unchanged';
  return read.paragraphs.some((text) => text.includes(nonce)) ? 'saved' : 'changed-without-nonce';
}

export const EXPECTED_DELTAS = {
  readBacks: 1,
  readBackHits: 1,
  requests: READ_BACK_REQUESTS,
  searches: 0,
  delegations: 0,
};
const COUNTERS = Object.keys(EXPECTED_DELTAS);

/** Each counter's delta from `before` to `after`; a counter missing from either yields NaN. */
export const providerDeltas = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  Object.fromEntries(COUNTERS.map((key) => [key, Number(after[key]) - Number(before[key])]));

/** No nonce, marker or key: digests, counter deltas and both browser sessions. */
export interface OfficeEditorEvidence {
  readonly file: string;
  readonly before: Digest;
  readonly after: Digest;
  readonly saved: true;
  readonly provider: Record<string, number>;
  readonly editor: StackBrowserEvidence;
  readonly readBack: StackBrowserEvidence;
}

const WORKER_403 = /^403 \/sidebar\/onlyoffice\/ds\/[^/]+\/document_editor_service_worker\.js$/;
// DS startup's pluginsmanager installs the marketplace AI plugin, whose zh-ZH helper translation is
// missing upstream; offline production never installs it (§51.2, user decision 2026-11-16).
const AI_PLUGIN_404 =
  /^404 \/sidebar\/onlyoffice\/ds\/[^/]+\/sdkjs-plugins\/%7B9DC93CDB-B576-4F0C-B55E-FCC9C48DD007%7D\/translations\/helpers\/zh-ZH\.json$/;
const NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)';

/** The editing session's console errors and `status path` responses >= 400: §48's ServiceWorker
 * refusal plus at most one AI plugin 404 and, only with that response, its console text. */
export function editorErrorsAllowed(errors: readonly string[], responses: string[], base: string) {
  const plugin = responses.filter((response) => AI_PLUGIN_404.test(response)).length;
  const [worker, ...others] = responses.filter((response) => !AI_PLUGIN_404.test(response));
  const texts = errors.filter((error) => error === NOT_FOUND).length;
  const refusals = errors.filter((error) => error !== NOT_FOUND);
  const workerOnly = others.length === 0 && WORKER_403.test(worker ?? '');
  return workerOnly && plugin <= 1 && texts <= plugin && serviceWorkerRefused(refusals, base);
}

const LISTS = ['consoleErrors', 'pageErrors', 'failedRequests', 'externalRequests'] as const;
const counted = (browser: StackBrowserEvidence) => ({
  screenshots: browser.screenshots,
  ...Object.fromEntries(LISTS.map((key) => [key, browser[key].length])),
});

/** The stack evidence line: each session by its screenshots and error counts. */
export function officeEditorLine(evidence: OfficeEditorEvidence | undefined) {
  if (evidence === undefined) throw new Error('Office editor evidence missing');
  const { editor, readBack, ...rest } = evidence;
  return { ...rest, editor: counted(editor), readBack: counted(readBack) };
}

/** A's lane plus the provider's own reply and read-back script, the values it was configured with. */
export type OfficeEditorLane = ArchiveLane & {
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
async function typeAndSave(page: Page, nonce: string, timeout: number) {
  try {
    const editor = page.locator(EDITOR_FRAME).visible().contentFrame();
    await editor.locator(EDITOR_AREA).click({ timeout });
    await page.keyboard.type(nonce);
    await page.keyboard.press(SAVE_KEY);
  } catch (cause) {
    const frames = JSON.stringify(await frameChain(page));
    throw new Error(`Office editor typing or saving failed, frames ${frames}`, { cause });
  }
}

/** Polls the instance's file for at most 120s; a timeout names the state it ended in. */
async function writtenBack(read: () => Promise<DocxRead>, original: string, nonce: string) {
  let last: DocxRead | undefined;
  let state: ReturnType<typeof writeBackState> = 'unchanged';
  const saved = async () => {
    last = await read();
    state = writeBackState(original, last, nonce);
    return state === 'saved';
  };
  const seen = () => ({ state, paragraphs: last?.paragraphs });
  await untilSeen(seen, saved, 120_000, 'Office editor write-back not saved, ended');
  if (last === undefined) throw new Error('Office editor write-back never read');
  return last;
}

/** One browser session opens, types, saves and sees the write-back; the file is read once more. */
async function editAndSave(lane: OfficeEditorLane, written: ArchiveEntry, directory: string) {
  const { exec, session, readBack } = lane;
  const read = async () => JSON.parse(await exec(READER_ARGV)) as DocxRead;
  const { paragraphs, sha256 } = await read();
  expect({ paragraphs, sha256 }).toEqual({ paragraphs: [PARAGRAPH], sha256: written.sha256 });
  await documentServerReady(lane);
  const names = { label: 'office editor', failure: 'office-editor-failure' };
  let saved: DocxRead | undefined;
  const body: Parameters<typeof workbenchSession>[2] = async (page, shoot) => {
    await openHinted(page, shoot, session, NAME, 'office-editor-open');
    await typeAndSave(page, readBack.nonce, session.timeout);
    saved = await writtenBack(read, written.sha256, readBack.nonce);
    await shoot('office-editor-saved');
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
    screenshots: ['office-editor-open.png', 'office-editor-saved.png'],
    ...{ pageErrors: 0, failedRequests: 0, externalRequests: 0 },
  });
  // A late status 2 may rewrite the bytes, never without the nonce.
  const closed = writeBackState(written.sha256, await read(), readBack.nonce);
  expect(closed, 'Office editor file after the browser closed').toBe('saved');
  if (saved === undefined) throw new Error('Office editor save not observed');
  return { editor, saved };
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
  // Fails at once when the read-back script never reached the provider.
  expect([start.readBacks, start.readBackHits], 'readBacks, readBackHits').toEqual([0, 0]);
  expect(lane.readBack.command.includes(lane.readBack.nonce), 'Command holds nonce').toBe(false);
  const written = JSON.parse(await lane.exec(WRITE_ARGV)) as ArchiveEntry;
  const directory = join(lane.session.directory, 'office-editor');
  const { editor, saved } = await editAndSave(lane, written, directory);
  const readBack = await agentReadBack(lane, start, directory);
  expect(counted(readBack)).toEqual({
    screenshots: ['login.png', 'workbench.png', 'reply.png'],
    ...{ consoleErrors: 0, pageErrors: 0, failedRequests: 0, externalRequests: 0 },
  });
  const provider = providerDeltas(start, await lane.provider());
  expect(provider, 'Provider deltas over the Office editor lane').toEqual(EXPECTED_DELTAS);
  const digest = ({ size, sha256 }: Digest) => ({ size, sha256 });
  const [before, after] = [digest(written), digest(saved)];
  return { file: NAME, before, after, saved: true, provider, editor, readBack };
}

/**
 * 18.5 (#440): A types into 编辑写回.docx in the ONLYOFFICE editor and saves; the instance's file
 * then holds the typed text and the Agent's `bash` read-back sees it. The file is then removed.
 */
export const officeEditorScenario = (lane: OfficeEditorLane): Promise<OfficeEditorEvidence> =>
  withWorkFiles(lane, [NAME], 'Office editor', () => officeEditor(lane));
