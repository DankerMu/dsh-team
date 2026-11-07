import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { ElementHandle, Page } from '@playwright/test';
import { expect } from 'vitest';
import {
  EXPAND_BUTTON,
  explorerReselect,
  FILES_GUIDE,
  rowQuery,
} from './better-sidebar-browser-fixture.mjs';
import { until, workbenchSession } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence, StackSession } from './stack-browser-fixture.ts';

/** One regular file of an archive, or of the instance's work directory. */
export interface ArchiveEntry {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}
/** `gnu` is GNU tar's default `ustar  \0` header; `ustar` is POSIX `ustar\0` + `00`. */
type TarFormat = 'gnu' | 'ustar';

const BLOCK = 512;
const isZero = (bytes: Buffer) => bytes.every((byte) => byte === 0);
/** A header field up to its first NUL; no UTF-8 sequence holds a zero byte. */
const field = (block: Buffer, start: number, length: number, encoding: BufferEncoding = 'latin1') =>
  block.toString(encoding, start, start + length).split('\u0000')[0] ?? '';
function octal(block: Buffer, start: number, length: number) {
  const text = field(block, start, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`Tar header field ${String(start)} malformed`);
  return Number.parseInt(text, 8);
}

/** The header's format once its magic and checksum (chksum read as eight spaces) are valid. */
function headerFormat(block: Buffer): TarFormat {
  const magic = block.toString('latin1', 257, 265);
  const format =
    magic === 'ustar  \u0000' ? 'gnu' : magic === 'ustar\u000000' ? 'ustar' : undefined;
  if (format === undefined) throw new Error('Tar header magic unsupported');
  let sum = 0;
  for (const [index, byte] of block.entries()) sum += index >= 148 && index < 156 ? 0x20 : byte;
  if (octal(block, 148, 8) !== sum) throw new Error('Tar header checksum mismatch');
  return format;
}

/**
 * The regular files of a gzip-compressed tar. Any other member type (long names `L`/`K`, pax
 * `x`/`g`, links) fails rather than being skipped; at least two zero blocks end the archive and
 * only zeros may follow them (GNU tar pads its output to a 10240-byte record).
 */
export function parseTarGz(compressed: Buffer): { format: TarFormat; entries: ArchiveEntry[] } {
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) throw new Error('Archive is not gzip');
  const tar = gunzipSync(compressed);
  const blockAt = (at: number) => tar.subarray(at, at + BLOCK);
  const formats = new Set<TarFormat>();
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  for (let block = blockAt(0); !isZero(block); block = blockAt(offset)) {
    if (block.length < BLOCK) throw new Error('Tar end blocks missing');
    formats.add(headerFormat(block));
    const type = block.toString('latin1', 156, 157);
    if (type !== '0' && type !== '\u0000') throw new Error(`Tar member type ${type} unsupported`);
    const size = octal(block, 124, 12);
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    if (data.length !== size) throw new Error('Tar member truncated');
    const sha256 = createHash('sha256').update(data).digest('hex');
    entries.push({ name: field(block, 0, 100, 'utf8'), size, sha256 });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  const rest = tar.subarray(offset);
  if (rest.length < 2 * BLOCK || !isZero(rest))
    throw new Error('Tar end blocks missing or followed by data');
  const [format, ...mixed] = formats;
  if (format === undefined || mixed.length > 0) throw new Error('Tar formats mixed or absent');
  return { format, entries };
}

/** Sorted by name: two lists compare equal only when they hold the same entries, in any order. */
export const byName = (entries: readonly ArchiveEntry[]) =>
  [...entries].sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));

const WORK = '/data/work';
const TEXT_NAME = '打包甲.txt';
const NAMES = [TEXT_NAME, 'archive-b.bin'];
const TEXT = '文件区打包下载的第一行。\n第二行：压缩包里应当恰好是这两个文件。\n第三行结束。\n';
// Python in the instance; names and text arrive as argv, never through a shell. Both files are
// read back from disk after writing: their sizes and sha256 are the expected values.
const WRITE = `import hashlib, json, pathlib, random, sys
work, text, binary, content = sys.argv[1:]
pathlib.Path(work, text).write_text(content, encoding="utf-8")
random.seed(430)
pathlib.Path(work, binary).write_bytes(random.randbytes(65536))
data = [(n, pathlib.Path(work, n).read_bytes()) for n in (text, binary)]
print(json.dumps([{"name": n, "size": len(b), "sha256": hashlib.sha256(b).hexdigest()} for n, b in data]))`;
const REMOVE = `import json, pathlib, sys
paths = [pathlib.Path(sys.argv[1], n) for n in sys.argv[2:]]
for p in paths: p.unlink(missing_ok=True)
print(json.dumps([p.exists() for p in paths]))`;
// better-sidebar 0.28.0's zh strings (lib/client.js zipDownloadCount, zipFailed, archiveToolMissing).
const MENU = '压缩并下载（2 项）';
const FAILURE_TEXTS = ['打包失败', '系统上没有可用的打包命令'];
const ROWS_SHOWN = NAMES.map((name) => `Boolean(${rowQuery(name)})`).join(' && ');
const SELECTION = `JSON.stringify({ rows: [${NAMES.map((name) => `(${rowQuery(name)})?.getAttribute('data-dsh-selected')`).join(', ')}], selected: document.querySelectorAll('[data-dsh-native-tab-host] [data-dsh-selected="true"]').length })`;

/** Everything the archive lane needs from the stack test. */
export interface ArchiveLane {
  readonly session: StackSession;
  /** Runs one command in the employee's instance as uid 1001; resolves with its stdout. */
  readonly exec: (args: readonly string[]) => Promise<string>;
  /** The owned provider's health counters. */
  readonly provider: () => Promise<Record<string, unknown>>;
}

export interface ArchiveEvidence {
  readonly browser: StackBrowserEvidence;
  readonly entries: readonly ArchiveEntry[];
  readonly format: TarFormat;
}

/** What an in-page expression yields: the typings, without the DOM lib, never admit null. */
const element = async (page: Page, expression: string): Promise<ElementHandle | null> =>
  (await page.evaluateHandle(expression)).asElement();

/** One step toward both rows visible: expand the Sidebar, take the guide or reselect the tab. */
async function showRows(page: Page): Promise<boolean> {
  if (await page.evaluate<boolean>(ROWS_SHOWN)) return true;
  for (const expression of [EXPAND_BUTTON, FILES_GUIDE, explorerReselect(TEXT_NAME)]) {
    const target = await element(page, expression);
    if (target !== null) return target.click().then(() => false);
  }
  return false;
}

type Shoot = (name: string) => Promise<void>;

/** Selects both rows, archives them from the context menu and saves the download. */
async function downloadArchive(page: Page, shoot: Shoot, saved: string, timeout: number) {
  await until(() => showRows(page), timeout, 'sidebar archive rows');
  for (const name of NAMES)
    await (await element(page, rowQuery(name)))?.click({ modifiers: ['ControlOrMeta'] });
  const bothOnly = JSON.stringify({ rows: ['true', 'true'], selected: 2 });
  const selection = async () => (await page.evaluate<string>(SELECTION)) === bothOnly;
  await until(selection, timeout, 'sidebar archive selection');
  await (await element(page, rowQuery(TEXT_NAME)))?.click({ button: 'right' });
  const item = page.getByRole('menuitem', { name: MENU, exact: true });
  await item.waitFor({ state: 'visible', timeout });
  await shoot('archive-menu');
  // Armed before the click, as STOP is: the archive can be ready within one 250ms poll.
  const [download] = await Promise.all([page.waitForEvent('download', { timeout }), item.click()]);
  expect(download.suggestedFilename()).toBe('archive.tar.gz');
  expect(await download.failure()).toBeNull();
  // Saved before the browser closes; the session's directory never holds the archive.
  await download.saveAs(saved);
  for (const text of FAILURE_TEXTS) expect(await page.getByText(text).count(), text).toBe(0);
}

/** The files, the browser session and every check of the lane; cleanup is the caller's. */
async function archiveDownload(lane: ArchiveLane): Promise<ArchiveEvidence> {
  const { exec, session } = lane;
  const counts = async () => {
    const { requests, searches, delegations } = await lane.provider();
    return { requests, searches, delegations };
  };
  const before = await counts();
  const written = await exec(['python3', '-c', WRITE, WORK, ...NAMES, TEXT]);
  // The instance's own JSON for the files it has just written.
  const expected = JSON.parse(written) as ArchiveEntry[];
  // Sizes first: two empty files would share a sha256.
  expect(expected.map(({ size }) => size)).toEqual([Buffer.byteLength(TEXT), 65_536]);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-stack-archive-'));
  try {
    const saved = join(directory, 'archive.tar.gz');
    const names = { label: 'sidebar archive', failure: 'archive-failure' };
    const browser = await workbenchSession(session, names, (page, shoot) =>
      downloadArchive(page, shoot, saved, session.timeout),
    );
    const { format, entries } = parseTarGz(await readFile(saved));
    expect(byName(entries)).toEqual(byName(expected));
    // GNU headers come from the image's Debian tar; the macOS host's bsdtar writes none.
    expect(format).toBe('gnu');
    // The host's release does not await the unlink of its temporary archive.
    const temp = ['find', '/tmp', '-maxdepth', '1', '-name', 'dsh-better-sidebar-ar-*'];
    await until(async () => (await exec(temp)) === '', session.timeout, 'archive temp release');
    expect(await counts(), 'No model request or retrieval').toEqual(before);
    return { browser, entries, format };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Better-sidebar's 「压缩并下载」 (#430): two work-directory files selected in the file area download
 * as one archive built in the instance, matching them byte for byte; both are then removed.
 */
export async function archiveScenario(lane: ArchiveLane): Promise<ArchiveEvidence> {
  const removed = async () => {
    const exists: unknown = JSON.parse(await lane.exec(['python3', '-c', REMOVE, WORK, ...NAMES]));
    expect(exists, 'Sidebar archive files removed').toEqual([false, false]);
  };
  const evidence = await archiveDownload(lane).catch(async (error: unknown) => {
    // The lane's failure stays first; a cleanup failure follows it.
    await removed().catch((cleanup: unknown) => {
      throw new AggregateError([error, cleanup], 'Sidebar archive lane and cleanup failed');
    });
    throw error;
  });
  await removed();
  return evidence;
}
