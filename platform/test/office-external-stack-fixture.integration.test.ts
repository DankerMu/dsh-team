import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import {
  apiScriptFailed,
  BAD_GATEWAY,
  badGatewayPaired,
  failureKeys,
  officeExternalLine,
  officeExternalScenario,
} from './office-external-stack-fixture.ts';
import type { ExternalOpen, OfficeExternalLane } from './office-external-stack-fixture.ts';
import { FAILURES, HEALTH_COMMAND, LOADING } from './office-hints-stack-fixture.ts';
import { LISTENER_JS, REWRITTEN_URL } from './office-profile-stack-fixture.ts';
import type { StackBrowserEvidence } from './stack-browser-fixture.ts';

const API_JS = '/sidebar/onlyoffice/ds/web-apps/apps/api/documents/api.js';
const BASE = 'http://127.0.0.1:8080';
const PATH = '/_platform/api/admin/document-server';
const FILE = { name: '外部失效.docx', size: 36_000, sha256: 'ab'.repeat(32) };

it('names each zh failure text of dsh-sidebar-onlyoffice@0.2.0 src/client/locales.ts by its key', () => {
  const zh = [
    '打开失败',
    '无法获取编辑器配置',
    '无法加载 ONLYOFFICE 编辑器脚本',
    'ONLYOFFICE 编辑器初始化失败',
    'ONLYOFFICE 编辑器发生错误',
  ];

  const keys = failureKeys(zh);

  expect(keys).toEqual(['loadFailed', 'errFetch', 'errApi', 'errEditor', 'errEditorEvent']);
});

it('keeps loading, English and office-hints texts as themselves, so no other text passes as a key', () => {
  const others = [...LOADING, 'Failed to open', 'Office 编辑器未加载'];

  const keys = failureKeys(others);

  expect(keys).toEqual(others);
  expect(FAILURES).toEqual(expect.arrayContaining(others.slice(2)));
});

it("pins the 502 console text to Chromium's resource-failure wording with Node's default reason", () => {
  expect(BAD_GATEWAY).toBe(
    'Failed to load resource: the server responded with a status of 502 (Bad Gateway)',
  );
});

const PAIR = [`502 ${BASE}${API_JS}`];
const FAILED = [`GET ${BASE}${API_JS}`];

it('accepts exactly the 502 console error, the proxied api.js 502 and its failed GET seen in the stack', () => {
  expect(badGatewayPaired([BAD_GATEWAY], PAIR, FAILED, BASE)).toBe(true);
  expect(badGatewayPaired([BAD_GATEWAY], PAIR, FAILED, `${BASE}/`)).toBe(true);
});

const NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)';

it.each([
  ['no console error', [], PAIR, FAILED],
  ['no response', [BAD_GATEWAY], [], FAILED],
  ['a second console error', [BAD_GATEWAY, BAD_GATEWAY], PAIR, FAILED],
  ['a different console error', [NOT_FOUND], PAIR, FAILED],
  ['a second response', [BAD_GATEWAY], [...PAIR, `404 ${BASE}/favicon.ico`], FAILED],
  ['two api.js 502s', [BAD_GATEWAY], [...PAIR, ...PAIR], FAILED],
  ['two paired 502s', [BAD_GATEWAY, BAD_GATEWAY], [...PAIR, ...PAIR], [...FAILED, ...FAILED]],
  ['a 502 on another path', [BAD_GATEWAY], [`502 ${BASE}/sidebar/onlyoffice/config`], FAILED],
  ['api.js answered 503', [BAD_GATEWAY], [`503 ${BASE}${API_JS}`], FAILED],
  ['api.js on another origin', [BAD_GATEWAY], [`502 http://127.0.0.1:9${API_JS}`], FAILED],
  ['no failed request', [BAD_GATEWAY], PAIR, []],
  ['two failed api.js GETs', [BAD_GATEWAY], PAIR, [...FAILED, ...FAILED]],
  ['a second failed request', [BAD_GATEWAY], PAIR, [...FAILED, `GET ${BASE}/favicon.ico`]],
  ['another failed URL', [BAD_GATEWAY], PAIR, [`GET ${BASE}/sidebar/onlyoffice/config`]],
  ['api.js failing on another origin', [BAD_GATEWAY], PAIR, [`GET http://127.0.0.1:9${API_JS}`]],
  ['api.js failing with a query', [BAD_GATEWAY], PAIR, [`GET ${BASE}${API_JS}?v=1`]],
  ['a failed POST of api.js', [BAD_GATEWAY], PAIR, [`POST ${BASE}${API_JS}`]],
])('rejects %s', (_name, errors: string[], responses: string[], failed: string[]) => {
  expect(badGatewayPaired(errors, responses, failed, BASE)).toBe(false);
});

it("accepts exactly the plugin's loadFailed heading followed by errApi", () => {
  expect(apiScriptFailed(['打开失败', '无法加载 ONLYOFFICE 编辑器脚本'])).toBe(true);
});

it.each([
  ['the heading alone', ['打开失败']],
  ['errApi alone', ['无法加载 ONLYOFFICE 编辑器脚本']],
  ['the loading text', [LOADING[0] ?? '']],
  [
    'the loading text with the failure',
    [LOADING[0] ?? '', '打开失败', '无法加载 ONLYOFFICE 编辑器脚本'],
  ],
  ["office-hints' UNAVAILABLE", ['Office 编辑器未加载']],
  [
    'UNAVAILABLE with the failure',
    ['打开失败', '无法加载 ONLYOFFICE 编辑器脚本', 'Office 编辑器未加载'],
  ],
  ['errFetch', ['打开失败', '无法获取编辑器配置']],
  ['errFetch besides errApi', ['打开失败', '无法获取编辑器配置', '无法加载 ONLYOFFICE 编辑器脚本']],
  [
    'errEditor after errApi',
    ['打开失败', '无法加载 ONLYOFFICE 编辑器脚本', 'ONLYOFFICE 编辑器初始化失败'],
  ],
  ['the English failure', ['Failed to open', 'Could not load the ONLYOFFICE editor script']],
  ['nothing', []],
])('rejects as the failure %s', (_name, texts: string[]) => {
  expect(apiScriptFailed(texts)).toBe(false);
});

const BROWSER: StackBrowserEvidence = {
  screenshots: ['office-external-failed.png'],
  consoleErrors: [BAD_GATEWAY],
  unloadViolations: [],
  pageErrors: [],
  failedRequests: [`GET ${BASE}${API_JS}`],
  externalRequests: [],
  requests: 40,
  websockets: 2,
};
const OPENED = { keys: ['loadFailed', 'errApi'], hints: ['collab', 'restart'], failureMs: 900 };

/** The administrator route as the platform answers it, every request recorded with its body. */
async function adminServer() {
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const state = { mode: 'bundled', url: '' };
  const failing = new Set<string>();
  const server = createServer((request, response) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (text += chunk));
    request.on('end', () => {
      // The fixture's own JSON request body; the fake trusts its shape.
      const body = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
      const method = request.method ?? '';
      calls.push({ method, path: request.url ?? '', body });
      const step = method === 'GET' ? 'GET' : `PUT ${String(body?.mode)}`;
      if (failing.has(step)) {
        response.writeHead(500).end();
        return;
      }
      if (body !== null) Object.assign(state, { mode: body.mode, url: body.url ?? '' });
      const external = state.mode === 'external';
      const projection = { ...state, bundledConfigured: true, jwtConfigured: external };
      const answer = body === null ? projection : { ...projection, runningInstances: 1 };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // A listening TCP server's address is an AddressInfo, never a pipe name or null.
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  servers.push(server);
  return { base, calls, state, failing };
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close();
    await once(server, 'close');
  }
});

/** What A answers otherwise: a listener at the address, the file read after the open, counters. */
interface Deviation {
  readonly listener?: boolean;
  readonly reread?: typeof FILE;
  readonly requests?: readonly number[];
}

/** A instance answering each command the lane sends, recorded in `events` in order. */
function fakeLane(base: string, events: string[], deviation: Deviation = {}): OfficeExternalLane {
  const { listener = false, reread = FILE, requests = [3, 3] } = deviation;
  let reads = 0;
  const exec = (args: readonly string[]) => {
    const [, , , target = ''] = args;
    if (args[0] === 'node' && (args.at(-1) ?? '').includes(LISTENER_JS)) {
      events.push('listener');
      return Promise.resolve(JSON.stringify({ listener }));
    }
    if (args.join(' ') === HEALTH_COMMAND.join(' ')) {
      events.push('health');
      return Promise.resolve(JSON.stringify({ status: 200, body: 'true' }));
    }
    if (target === '/data/work') {
      events.push('remove');
      return Promise.resolve(JSON.stringify([false]));
    }
    const written = args.length === 5;
    events.push(written ? 'write' : 'read');
    return Promise.resolve(JSON.stringify(written ? FILE : reread));
  };
  return {
    session: { base, directory: '/tmp', email: 'a@example.test', password: 'p', timeout: 1_000 },
    exec,
    provider: () => Promise.resolve({ requests: requests[reads++], searches: 0, delegations: 0 }),
    administrator: { base, cookie: 'dsh_team_session=admin' },
    restart: () => {
      events.push('restart');
      return Promise.resolve();
    },
  };
}

/** The browser half: records its turn and answers with the stack's failure, or as `observed`. */
const opening =
  (events: string[], observed: Partial<ExternalOpen> = {}) =>
  (session: { base: string }): Promise<ExternalOpen> => {
    events.push('open');
    const { origin } = new URL(session.base);
    const responses = [`502 ${origin}${API_JS}`];
    const browser = { ...BROWSER, failedRequests: [`GET ${origin}${API_JS}`] };
    return Promise.resolve({ browser, responses, failure: OPENED, ...observed });
  };

/** The JWT the lane PUT, read back from the fake's request log. */
const secretOf = (calls: Awaited<ReturnType<typeof adminServer>>['calls']) =>
  String(calls.find(({ body }) => body?.mode === 'external')?.body?.jwtSecret);

const failureText = (error: unknown): string =>
  error instanceof AggregateError
    ? [error.message, ...error.errors.map(failureText)].join('\n')
    : String(error instanceof Error ? error.message : error);

it('switches to the refused external address, opens the DOCX and restores bundled mode after it', async () => {
  const admin = await adminServer();
  const events: string[] = [];

  const evidence = await officeExternalScenario(fakeLane(admin.base, events), opening(events));

  expect(admin.calls.map(({ method, body }) => [method, body?.mode, body?.url])).toEqual([
    ['GET', undefined, undefined],
    ['PUT', 'external', REWRITTEN_URL],
    ['PUT', 'bundled', undefined],
    ['GET', undefined, undefined],
  ]);
  expect(admin.calls.every(({ path }) => path === PATH)).toBe(true);
  const secret = secretOf(admin.calls);
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(Object.keys(admin.calls[2]?.body ?? {})).toEqual(['mode']);
  const restore = ['restart', 'health'];
  expect(events).toEqual(['restart', 'listener', 'write', 'open', 'read', 'remove', ...restore]);
  expect(admin.state).toEqual({ mode: 'bundled', url: '' });
  const line = officeExternalLine(evidence);
  expect(line).toEqual({
    ...OPENED,
    file: FILE,
    consoleErrors: [BAD_GATEWAY],
    responses: [`502 ${admin.base}${API_JS}`],
    failedRequests: [`GET ${admin.base}${API_JS}`],
    browser: {
      screenshots: ['office-external-failed.png'],
      unloadViolations: [],
      ...{ consoleErrors: 1, pageErrors: 0, failedRequests: 1, externalRequests: 0 },
    },
    restored: { config: 'bundled', healthcheck: true },
  });
  expect(JSON.stringify(line)).not.toContain(secret);
});

it('never switches or restores when Office does not start bundled', async () => {
  const admin = await adminServer();
  admin.state.mode = 'external';
  admin.state.url = 'http://office.example.test';
  const events: string[] = [];

  const run = officeExternalScenario(fakeLane(admin.base, events), opening(events));

  await expect(run).rejects.toThrow('Office starts bundled with the delivered Document Server');
  expect(admin.calls.map(({ method }) => method)).toEqual(['GET']);
  expect(events).toEqual([]);
});

it('restores bundled mode when the open fails, the open failure first and no JWT in it', async () => {
  const admin = await adminServer();
  const events: string[] = [];
  const failed = () => {
    events.push('open');
    return Promise.reject(new Error('ONLYOFFICE texts, seen errFetch'));
  };

  const error: unknown = await officeExternalScenario(fakeLane(admin.base, events), failed).catch(
    (caught: unknown) => caught,
  );

  expect(failureText(error)).toBe('ONLYOFFICE texts, seen errFetch');
  expect(events).toEqual(['restart', 'listener', 'write', 'open', 'remove', 'restart', 'health']);
  expect(admin.state).toEqual({ mode: 'bundled', url: '' });
  expect(failureText(error)).not.toContain(secretOf(admin.calls));
});

it('fails on any console error or response beyond the paired 502, after restoring bundled mode', async () => {
  const admin = await adminServer();
  const events: string[] = [];
  const browser = { ...BROWSER, consoleErrors: [BAD_GATEWAY, BAD_GATEWAY] };

  const run = officeExternalScenario(fakeLane(admin.base, events), opening(events, { browser }));

  await expect(run).rejects.toThrow(/consoleErrors, responses, failedRequests/);
  expect(events.slice(-3)).toEqual(['remove', 'restart', 'health']);
  expect(admin.state.mode).toBe('bundled');
});

it.each([
  ['no failed request', []],
  ['a second failed request', [`GET {base}${API_JS}`, `GET {base}/favicon.ico`]],
  ['another failed URL', [`GET {base}/sidebar/onlyoffice/config`]],
])('fails on %s beside the paired 502, after restoring bundled mode', async (_name, failed) => {
  const admin = await adminServer();
  const events: string[] = [];
  const failedRequests = failed.map((entry) => entry.replace('{base}', admin.base));
  const browser = { ...BROWSER, failedRequests };

  const run = officeExternalScenario(fakeLane(admin.base, events), opening(events, { browser }));

  await expect(run).rejects.toThrow(/consoleErrors, responses, failedRequests/);
  expect(events.slice(-3)).toEqual(['remove', 'restart', 'health']);
  expect(admin.state.mode).toBe('bundled');
});

it.each([
  [
    'something listens at the refused address',
    { listener: true },
    `Nothing listens at ${REWRITTEN_URL} in A`,
  ],
  [
    'the file changed by opening it',
    { reread: { ...FILE, sha256: 'cd'.repeat(32) } },
    'Office external file unchanged by opening it',
  ],
  ['a model request during the open', { requests: [3, 4] }, 'No model request or retrieval'],
])('fails when %s, after restoring bundled mode', async (_name, deviation: Deviation, message) => {
  const admin = await adminServer();
  const events: string[] = [];

  const run = officeExternalScenario(fakeLane(admin.base, events, deviation), opening(events));

  await expect(run).rejects.toThrow(message);
  expect(events.slice(-3)).toEqual(['remove', 'restart', 'health']);
  expect(admin.state).toEqual({ mode: 'bundled', url: '' });
});

it('restores bundled mode when saving the external server fails, naming only method, path and status', async () => {
  const admin = await adminServer();
  admin.failing.add('PUT external');
  const events: string[] = [];

  const error: unknown = await officeExternalScenario(
    fakeLane(admin.base, events),
    opening(events),
  ).catch((caught: unknown) => caught);

  expect(failureText(error)).toBe(`Administrator PUT ${PATH} answered 500`);
  expect(admin.calls.map(({ method, body }) => [method, body?.mode])).toEqual([
    ['GET', undefined],
    ['PUT', 'external'],
    ['PUT', 'bundled'],
    ['GET', undefined],
  ]);
  expect(events).toEqual(['restart', 'health']);
  expect(failureText(error)).not.toContain(secretOf(admin.calls));
});

it('keeps the open failure first and the failed restore after it', async () => {
  const admin = await adminServer();
  admin.failing.add('PUT bundled');
  const events: string[] = [];
  const failed = () => Promise.reject(new Error('ONLYOFFICE never failed'));

  const error: unknown = await officeExternalScenario(fakeLane(admin.base, events), failed).catch(
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(AggregateError);
  expect(failureText(error).split('\n')).toEqual([
    'Office external lane and its bundled restore failed',
    'ONLYOFFICE never failed',
    `Administrator PUT ${PATH} answered 500`,
  ]);
  expect(events).toEqual(['restart', 'listener', 'write', 'remove']);
  expect(failureText(error)).not.toContain(secretOf(admin.calls));
});

it('fails the lane when the restore after a passing open fails', async () => {
  const admin = await adminServer();
  const events: string[] = [];
  const lane = fakeLane(admin.base, events);
  const restart = lane.restart;
  // The second restart is the restore's: it fails before the healthcheck.
  let restarts = 0;
  const flaky = {
    ...lane,
    restart: () => (++restarts === 2 ? Promise.reject(new Error('A not ready')) : restart()),
  };

  const run = officeExternalScenario(flaky, opening(events));

  await expect(run).rejects.toThrow('A not ready');
  expect(events).toEqual(['restart', 'listener', 'write', 'open', 'read', 'remove']);
  expect(admin.state.mode).toBe('bundled');
});

it('throws when the stack ran without the Office external evidence', () => {
  expect(() => officeExternalLine(undefined)).toThrow('Office external evidence missing');
});
