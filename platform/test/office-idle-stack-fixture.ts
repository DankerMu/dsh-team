import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { FrameLocator } from '@playwright/test';
import { expect } from 'vitest';
import {
  counted,
  digest,
  editAndSave,
  editorNonce,
  retiringOnError,
} from './office-editor-stack-fixture.ts';
import type { Digest, Meeting, OfficeEditorLane } from './office-editor-stack-fixture.ts';
import { DOCUMENT_SERVER } from './office-hints-stack-fixture.ts';
import { withWorkFiles } from './sidebar-archive-stack-fixture.ts';
import type { StackBrowserEvidence } from './stack-browser-fixture.ts';

const ADMIN = '/_platform/api/admin';
const NAME = '编辑写回.docx';
// Above the idle stop's worst case at one minute: three 60s sweeps plus the stop (§51-f).
const HOLD_MS = 210_000;
const CONTROL_MS = 240_000;
const CUSTOM_FONTS = '/usr/share/fonts/truetype/custom';
/** The operator fonts compose binds into the Document Server: one `file<TAB>families` line per
 * face, subdirectories included (§51-g). */
export const OPERATOR_FONTS = [
  'exec',
  DOCUMENT_SERVER,
  'fc-scan',
  '--format',
  '%{file}\t%{family}\n',
  CUSTOM_FONTS,
];

type Admin = Readonly<Record<'base' | 'cookie', string>>;
type InstanceRow = Readonly<{ email: string; status: string; lastStartedAt: number | null }>;
type StopAudit = Readonly<{ id: number; actorEmail: string | null; details: unknown }>;

/** One administrator request; a non-200 answer throws with the method, path and status only. */
async function request<T>({ base, cookie }: Admin, method: string, path: string, body?: unknown) {
  const sent = body === undefined ? {} : { origin: base, 'content-type': 'application/json' };
  const response = await fetch(`${base}${path}`, {
    ...{ method, headers: { cookie, ...sent } },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (response.status !== 200) {
    await response.arrayBuffer();
    throw new Error(`Administrator ${method} ${path} answered ${String(response.status)}`);
  }
  // The platform's JSON crosses an HTTP boundary; callers assert each field they consume.
  return (await response.json()) as T;
}

/** PUTs the whole runtime configuration with `minutes`; the returned function PUTs it back. */
export async function idleMinutes(admin: Admin, minutes: number) {
  const path = `${ADMIN}/runtime-config`;
  const original = await request<Record<string, unknown>>(admin, 'GET', path);
  await request(admin, 'PUT', path, { ...original, idleMinutes: minutes });
  return () => request(admin, 'PUT', path, original).then(() => undefined);
}

async function instanceRow(admin: Admin, email: string) {
  const { items } = await request<{ items: InstanceRow[] }>(admin, 'GET', `${ADMIN}/instances`);
  const rows = items.filter((row) => row.email === email);
  const [row] = rows;
  if (row === undefined || rows.length > 1)
    throw new Error(`${email} has ${String(rows.length)} instance rows`);
  return row;
}

async function stopsAfter(admin: Admin, email: string, sinceId: number) {
  const query = new URLSearchParams({ eventType: 'instance.stopped', email }).toString();
  const path = `${ADMIN}/audit-events?${query}`;
  const { items } = await request<{ items: StopAudit[] }>(admin, 'GET', path);
  return items.filter(({ id }) => id > sinceId);
}

/** `email` runs before and after `holdMs`, not restarted, and no stop audit follows the newest
 * one before; `heldMs` is measured between the two row reads. */
export async function heldRunning(admin: Admin, email: string, holdMs: number) {
  const before = await instanceRow(admin, email);
  const start = performance.now();
  expect(before.status, `${email} running before the hold`).toBe('running');
  const sinceId = Math.max(0, ...(await stopsAfter(admin, email, 0)).map(({ id }) => id));
  // A timer may fire a fraction of a millisecond early on this clock.
  while (performance.now() - start < holdMs) await delay(holdMs - (performance.now() - start));
  const after = await instanceRow(admin, email);
  const heldMs = Math.round(performance.now() - start);
  expect(heldMs, `${email} held for at least ${String(holdMs)}ms`).toBeGreaterThanOrEqual(holdMs);
  const restarted = after.lastStartedAt !== before.lastStartedAt;
  const idleStops = (await stopsAfter(admin, email, sinceId)).length;
  const held = { heldMs, status: after.status, restarted, idleStops };
  const running = { heldMs, status: 'running', restarted: false, idleStops: 0 };
  expect(held, `${email} held running with the editor open`).toEqual(running);
  return { held, sinceId };
}

/** Reads `email`'s row every 5s until it is stopped within `timeoutMs`; the one stop audit after
 * `sinceId` is then the platform's idle stop. `stoppedMs` runs from the call to `stopped`. */
export async function idleRetired(admin: Admin, email: string, sinceId: number, timeoutMs: number) {
  const start = performance.now();
  let { status } = await instanceRow(admin, email);
  while (status !== 'stopped') {
    const left = timeoutMs - (performance.now() - start);
    if (left <= 0)
      throw new Error(`${email} not stopped within ${String(timeoutMs)}ms, last status ${status}`);
    await delay(Math.min(5_000, left));
    ({ status } = await instanceRow(admin, email));
  }
  const stoppedMs = Math.round(performance.now() - start);
  const newer = await stopsAfter(admin, email, sinceId);
  const audits = newer.map(({ actorEmail, details }) => ({ actorEmail, details }));
  const idle = [{ actorEmail: null, details: { reason: 'idle' } }];
  expect(audits, `${email}'s stop audits after the hold`).toEqual(idle);
  return { stoppedMs, reason: 'idle' as const };
}

type OperatorFont = Readonly<{ file: string; families: readonly string[] }>;

/** fc-scan's faces grouped by file, each with the union of its comma-separated families. */
export function operatorFonts(output: string): OperatorFont[] {
  const files = new Map<string, Set<string>>();
  for (const line of output.split('\n').filter((text) => text !== '')) {
    const [file = '', names = ''] = line.split('\t');
    const families = files.get(file) ?? new Set<string>();
    for (const name of names.split(',')) if (name !== '') families.add(name);
    files.set(file, families);
  }
  if (files.size === 0) throw new Error(`Operator font directory ${CUSTOM_FONTS} has no font file`);
  return [...files].map(([file, families]) => ({ file, families: [...families] }));
}

/** Every operator font file has a family among the editor's font `names`: the file count and the
 * matched names, deduplicated and sorted. */
export function fontsShown(fonts: readonly OperatorFont[], names: unknown) {
  if (!Array.isArray(names) || !(names as unknown[]).every((name) => typeof name === 'string'))
    throw new Error('Office editor font names (AscFonts.g_font_infos) are not a string array');
  const shown = new Set<unknown>(names);
  const missing = fonts.filter(({ families }) => !families.some((name) => shown.has(name)));
  if (missing.length > 0) {
    const lines = missing.map(({ file, families }) => `${file}: ${families.join(', ')}`);
    throw new Error(`Operator fonts missing from the editor's font list: ${lines.join('; ')}`);
  }
  const families = new Set(fonts.flatMap(({ families }) => families.filter((n) => shown.has(n))));
  return { files: new Set(fonts.map(({ file }) => file)).size, families: [...families].sort() };
}

/** The Name of every font the editor frame loaded from AllFonts.js; not an array when unreadable. */
const editorFontNames = (editor: FrameLocator) =>
  editor.locator('#editor_sdk').evaluate(() => {
    const loaded = globalThis as { AscFonts?: { g_font_infos?: unknown } };
    const infos = loaded.AscFonts?.g_font_infos;
    return Array.isArray(infos) ? infos.map((info: { Name?: unknown }) => info.Name) : null;
  });

/** No nonce or key: the hold, the fonts, the DOCX's digests, the editor session and the idle stop. */
export interface OfficeIdleEvidence {
  readonly held: Awaited<ReturnType<typeof heldRunning>>['held'];
  readonly fonts: ReturnType<typeof fontsShown>;
  readonly file: Readonly<Record<'before' | 'after', Digest>>;
  readonly editor: StackBrowserEvidence;
  readonly stopped: Awaited<ReturnType<typeof idleRetired>>;
}

/** The stack evidence line: the editor session by its screenshots and error counts. */
export function officeIdleLine(evidence: OfficeIdleEvidence | undefined) {
  if (evidence === undefined) throw new Error('Office idle evidence missing');
  const { editor, ...rest } = evidence;
  return { ...rest, editor: counted(editor) };
}

/** A's editor lane plus the administrator, who sets and restores the idle minutes. */
type OfficeIdleLane = OfficeEditorLane & { readonly administrator: Admin };

async function officeIdle(lane: OfficeIdleLane, idle: { restore: () => Promise<void> }) {
  const { administrator: admin, session } = lane;
  const operator = operatorFonts(await lane.run(OPERATOR_FONTS));
  let fonts: ReturnType<typeof fontsShown> | undefined;
  let hold: Awaited<ReturnType<typeof heldRunning>> | undefined;
  const loaded = async (editor: FrameLocator) => {
    // Before the idle minutes change: a failed font check leaves them as they were.
    fonts = fontsShown(operator, await editorFontNames(editor));
    idle.restore = await idleMinutes(admin, 1);
    hold = await heldRunning(admin, session.email, HOLD_MS);
  };
  const meeting: Meeting = { nonce: editorNonce(), loaded, saved: () => Promise.resolve() };
  const directory = join(session.directory, 'office-idle');
  const { editor, written, after } = await withWorkFiles(lane, [NAME], 'Office idle', () =>
    editAndSave(lane, 'docx', directory, meeting),
  );
  if (hold === undefined || fonts === undefined) throw new Error('Office idle hold not observed');
  // The browser has closed and the file is gone: nothing holds a gateway connection to A now.
  const stopped = await idleRetired(admin, session.email, hold.sinceId, CONTROL_MS);
  const file = { before: digest(written), after: digest(after) };
  return { held: hold.held, fonts, file, editor, stopped };
}

/**
 * 18.5 (#440): with one idle minute, A's open DOCX editor keeps the instance running past the idle
 * window and still saves; once the browser closes, the platform idle-stops A. The idle minutes are
 * restored either way; a restore failure follows the lane's.
 */
export async function officeIdleScenario(lane: OfficeIdleLane): Promise<OfficeIdleEvidence> {
  const idle = { restore: () => Promise.resolve() };
  const failed = 'Office idle lane and its restore failed';
  const run = () => officeIdle(lane, idle);
  const evidence = await retiringOnError(run, () => idle.restore(), failed);
  await idle.restore();
  return evidence;
}
