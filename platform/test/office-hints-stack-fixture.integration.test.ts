import { expect, it } from 'vitest';
import {
  COLLAB,
  docxCommand,
  editorSettled,
  HEALTH_COMMAND,
  OFFICE_FACTS,
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
    expect(OFFICE_FACTS).toContain(part);
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
