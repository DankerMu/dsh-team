import { afterEach, expect, it, vi } from 'vitest';
import { previewIds, visible } from './better-sidebar-browser-fixture.mjs';
import {
  COLLAB,
  DOCUMENT_SERVER,
  docserviceSpawns,
  documentServerStarted,
  docxCommand,
  editorSettled,
  HEALTH_COMMAND,
  officeFacts,
  officeHintsLine,
  serviceWorkerRefused,
} from './office-hints-stack-fixture.ts';

it('writes the docx as uid 1001 through argv and reads it back without the paragraph', () => {
  const write = docxCommand('同写提示.docx', '一段文字');
  const read = docxCommand('同写提示.docx');

  expect(write.slice(0, 2)).toEqual(['python3', '-c']);
  expect(write.slice(3)).toEqual(['/data/work/同写提示.docx', '一段文字']);
  expect(write[2]).toContain('from docx import Document');
  expect(read).toEqual([...write.slice(0, 4)]);
});

it("polls the Document Server healthcheck at the instance's own address with a loopback Host", () => {
  const [python, flag, script] = HEALTH_COMMAND;

  expect([python, flag, HEALTH_COMMAND.length]).toEqual(['python3', '-c', 3]);
  for (const part of [
    'socket.gethostbyname(socket.gethostname()), 3080',
    '"/sidebar/onlyoffice/ds/healthcheck"',
    '{"Host": "127.0.0.1:3080"}',
  ])
    expect(script).toContain(part);
});

it('reads hints, the wrapper frame, its iframes and the ONLYOFFICE texts of 0.2.0 locales', () => {
  for (const part of [
    "'[data-dsh-team-office-hint]'",
    '\'[data-dsh-team-office-hints="docx"]\'',
    "el.closest('[data-dsh-native-tab-host]') !== null",
    "querySelectorAll('iframe')",
    'url.origin === location.origin',
    'document.body.innerText',
    '"正在打开 ONLYOFFICE …"',
    '"Opening in ONLYOFFICE …"',
    '"ONLYOFFICE 编辑器发生错误"',
    '"The ONLYOFFICE editor reported an error"',
    '"Office 编辑器未加载"',
  ])
    expect(officeFacts('同写提示.docx')).toContain(part);
  for (const ext of ['xlsx', 'pptx'])
    expect(officeFacts(`编辑写回.${ext}`)).toContain(`'[data-dsh-team-office-hints="${ext}"]'`);
});

it('names the id of every visible preview container, of any id, whose address ends in /<name>', () => {
  expect(previewIds('编辑写回.xlsx')).toBe(
    `[...document.querySelectorAll("[data-document-preview]")].filter((el) => (${visible})(el) && decodeURIComponent(el.getAttribute('data-textpreview-url') ?? '').endsWith("/编辑写回.xlsx")).map((el) => el.getAttribute('data-document-preview'))`,
  );
});

const collab = { kind: 'collab', text: COLLAB, visible: true, nativeHost: true };
const frame = { visible: true, sameOrigin: true, path: '/sidebar/onlyoffice/ds/9.4.0/x.html' };
const mounted = { hints: [collab], frames: 1, iframes: [frame], texts: [] };

it.each([
  ['the visible hint over a mounted proxy iframe', mounted, true],
  ['the loading overlay', { ...mounted, texts: ['正在打开 ONLYOFFICE …'] }, false],
  ['an iframe outside the proxy', { ...mounted, iframes: [{ ...frame, path: '/' }] }, false],
  ['a hidden hint', { ...mounted, hints: [{ ...collab, visible: false }] }, false],
  ['a failure text', { ...mounted, iframes: [], texts: ['打开失败'] }, true],
  ['the no-session hint', { ...mounted, hints: [{ ...collab, kind: 'no-session' }] }, true],
])('settles on %s: %s', (_case, facts, settled) => {
  expect(editorSettled(facts)).toBe(settled);
});

it('prints the file, the hint and the screenshots, never the browser lists', () => {
  const file = { name: '同写提示.docx', size: 36_000, sha256: 'a'.repeat(64) };
  const lists = { consoleErrors: [], pageErrors: [], failedRequests: [], externalRequests: [] };
  const browser = {
    ...lists,
    screenshots: ['office-hints-collab.png'],
    requests: 9,
    websockets: 1,
  };

  expect(officeHintsLine({ file, hint: COLLAB, browser })).toEqual({
    ...file,
    hint: '请勿在 AI 修改此文件时同时编辑；人工修改保存完成后，再让 AI 继续处理。',
    screenshots: ['office-hints-collab.png'],
  });
});

it('fails the evidence line when the scenario left no evidence', () => {
  expect(() => officeHintsLine(undefined)).toThrow('Office hints evidence missing');
});

const BASE = 'http://127.0.0.1:64694';
const FETCH = 'A bad HTTP response code (403) was received when fetching the script.';
const register = (origin: string, scope: string, script: string) =>
  `Registration failed with TypeError: Failed to register a ServiceWorker for scope ('${origin}/sidebar/onlyoffice/ds/${scope}/') with script ('${origin}/sidebar/onlyoffice/ds/${script}'): ${FETCH}`;
const VERSION = '9.4.0-c83aecd3de42866b80ccf786af6354d6';
const WORKER = `${VERSION}/document_editor_service_worker.js`;
const refused = [FETCH, register(BASE, VERSION, WORKER)];

it.each([
  ["the gateway's two ServiceWorker refusals, in order", true, refused],
  ['the fetch error missing', false, refused.slice(1)],
  ['the registration error missing', false, refused.slice(0, 1)],
  ['an extra entry', false, [...refused, 'Uncaught TypeError: x']],
  ['the wrong order', false, [...refused].reverse()],
  ['a foreign origin', false, [FETCH, register('http://127.0.0.1:1', VERSION, WORKER)]],
  ['another script', false, [FETCH, register(BASE, VERSION, `${VERSION}/sw.js`)]],
  [
    'mismatched versions',
    false,
    [FETCH, register(BASE, VERSION, '9.4.1-x/document_editor_service_worker.js')],
  ],
  ['an empty segment', false, [FETCH, register(BASE, '', '/document_editor_service_worker.js')]],
  [
    'a segment holding a slash',
    false,
    [FETCH, register(BASE, 'a/b', 'a/b/document_editor_service_worker.js')],
  ],
])('allows %s: %s', (_case, allowed, errors) => {
  expect(serviceWorkerRefused(errors, `${BASE}/`)).toBe(allowed);
});

const PGREP = ['exec', 'dsh-team-documentserver', 'pgrep', '-f', 'xargs tail -F'];
const INSPECT = ['inspect', '-f', '{{.State.StartedAt}}', 'dsh-team-documentserver'];
const LOG = '/var/log/supervisor/supervisord.log';
const SPAWNS = ['exec', 'dsh-team-documentserver', 'grep', '-c', "spawned: 'docservice'", LOG];

/** A docker `run` whose pgrep fails `failures` times; every argv it saw, in order. */
function fakeDocker(failures: number, spawns = '2\n') {
  const calls: string[][] = [];
  let pgrep = 0;
  const run = (args: string[]) => {
    calls.push(args);
    if (args[2] === 'pgrep') {
      pgrep += 1;
      if (pgrep <= failures)
        return Promise.reject(
          new Error(`docker ${args.join(' ')} failed (1): poll ${String(pgrep)}`),
        );
      return Promise.resolve('412\n');
    }
    if (args[0] === 'inspect') return Promise.resolve('2026-11-17T06:21:12.08079575Z\n');
    return Promise.resolve(spawns);
  };
  return { calls, run };
}

afterEach(() => {
  vi.useRealTimers();
});

it('names the delivered Document Server container', () => {
  expect(DOCUMENT_SERVER).toBe('dsh-team-documentserver');
});

it('polls pgrep until the startup script tails its logs, then reads StartedAt and the spawns', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T06:22:22.5Z'));
  const { calls, run } = fakeDocker(3);

  // 06:21:12.080 (nine-digit fraction) to 06:22:22.500.
  expect(await documentServerStarted(run, 10_000)).toEqual({ startupMs: 70_420, spawns: 2 });
  expect(calls).toEqual([PGREP, PGREP, PGREP, PGREP, INSPECT, SPAWNS]);
});

it('fails on timeout with the last pgrep error and reads nothing else', async () => {
  const { calls, run } = fakeDocker(Number.POSITIVE_INFINITY);

  const waited = documentServerStarted(run, 300);
  await expect(waited).rejects.toThrow('Document Server startup script not finished, last');
  const last = calls.length;
  await expect(waited).rejects.toThrow(`poll ${String(last)}"`);
  expect(last).toBeGreaterThan(1);
  expect(calls).toEqual(Array.from({ length: last }, () => PGREP));
});

it('fails when StartedAt is not a timestamp', async () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return Promise.resolve(args[0] === 'inspect' ? '<no value>\n' : '1\n');
  };

  await expect(documentServerStarted(run, 1_000)).rejects.toThrow(
    'Document Server StartedAt unreadable: "<no value>"',
  );
  expect(calls).toEqual([PGREP, INSPECT]);
});

it.each([
  ['2\n', 2],
  ['13', 13],
])('counts the docservice spawns in %j as %d', async (stdout, count) => {
  const { calls, run } = fakeDocker(0, stdout);

  expect(await docserviceSpawns(run)).toBe(count);
  expect(calls).toEqual([SPAWNS]);
});

it.each(['', 'x\n', '-1', '2 3'])('fails on an unreadable spawn count %j', async (stdout) => {
  const { run } = fakeDocker(0, stdout);

  await expect(docserviceSpawns(run)).rejects.toThrow('docservice spawn count unreadable');
});
