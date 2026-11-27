import { expect, it } from 'vitest';
import type { AsyncDockerCommand, DockerCommandResult } from './docker-command.ts';
import {
  expectNoPanelSecrets,
  expectPanelEvidence,
  panelNeedles,
  panelSnapshot,
  panelStep,
  resourceScan,
  scannedKind,
  settledPanel,
} from './knowledge-panel-stack-fixture.ts';
import type {
  PanelNeedles,
  PanelSessionEvidence,
  PanelSnapshot,
  PanelStep,
  ResourceScan,
  ScannedResponse,
} from './knowledge-panel-stack-fixture.ts';
import type { StackBrowserEvidence } from './stack-browser-fixture.ts';

const LISTED: PanelSnapshot = {
  loading: 0,
  buttons: ['刷新', 'dsh-team-seed-policies', '筛选'],
  datasets: { state: 'list', text: 'dsh-team-seed-policies', names: ['dsh-team-seed-policies'] },
  files: [{ state: 'list', names: ['expense-policy.txt'], hint: false }],
};

it('accepts the in-page panel snapshot as observed', () => {
  expect(panelSnapshot(LISTED)).toEqual(LISTED);
  const closed = { loading: 0, buttons: [], datasets: null, files: [] };
  expect(panelSnapshot(closed)).toEqual(closed);
});

it.each([
  ['a missing value', undefined],
  ['an array', []],
  ['a negative loading count', { ...LISTED, loading: -1 }],
  ['a fractional loading count', { ...LISTED, loading: 0.5 }],
  ['non-string buttons', { ...LISTED, buttons: [1] }],
  ['an unknown list state', { ...LISTED, datasets: { ...LISTED.datasets, state: 'ready' } }],
  ['a null list state', { ...LISTED, datasets: { ...LISTED.datasets, state: null } }],
  ['non-string names', { ...LISTED, datasets: { ...LISTED.datasets, names: [null] } }],
  ['a missing list text', { ...LISTED, datasets: { state: 'list', names: [] } }],
  ['a files object', { ...LISTED, files: {} }],
  ['an unknown files state', { ...LISTED, files: [{ state: 'busy', names: [], hint: false }] }],
  ['a non-boolean hint', { ...LISTED, files: [{ state: 'list', names: [], hint: 'no' }] }],
])('rejects a snapshot with %s', (_label, value) => {
  expect(() => panelSnapshot(value)).toThrow('Knowledge panel snapshot malformed');
});

it('waits until the panel is open and nothing is loading', async () => {
  const observed: PanelSnapshot[] = [
    { loading: 0, buttons: [], datasets: null, files: [] },
    { ...LISTED, loading: 1, datasets: { state: 'loading', text: '', names: [] } },
    { ...LISTED, loading: 1 },
    LISTED,
  ];
  let reads = 0;
  const settled = await settledPanel(() => Promise.resolve(observed[reads++] ?? LISTED), 5_000);

  expect(settled).toEqual(LISTED);
  expect(reads).toBe(4);
});

it('fails when the panel never settles within the timeout', async () => {
  const loading: PanelSnapshot = { ...LISTED, loading: 1 };

  await expect(settledPanel(() => Promise.resolve(loading), 300)).rejects.toThrow(
    'Stack workbench knowledge panel settled not reached',
  );
});

it('records a step with its state, counts and screenshot only', () => {
  expect(panelStep('files', LISTED, 'kb-files')).toEqual({
    step: 'files',
    state: 'list',
    datasets: 1,
    files: 1,
    screenshot: 'kb-files.png',
  });
  const unconfigured: PanelSnapshot = {
    loading: 0,
    buttons: ['刷新'],
    datasets: { state: 'not-configured', text: '知识库未配置，请联系管理员', names: [] },
    files: [],
  };
  expect(panelStep('not-configured', unconfigured, 'kb-not-configured')).toEqual({
    step: 'not-configured',
    state: 'not-configured',
    datasets: 0,
    files: 0,
    screenshot: 'kb-not-configured.png',
  });
  expect(() => panelStep('closed', { ...unconfigured, datasets: null }, 'kb-closed')).toThrow(
    'Knowledge panel not open',
  );
});

const BASE = 'http://127.0.0.1:43210';
const TOKEN = 'b'.repeat(64);
const NEEDLES: PanelNeedles = {
  ragflowApiKey: 'ragflow-key-nonce',
  ragflowBaseUrl: 'http://host.docker.internal:9380',
  instanceToken: TOKEN,
  platformUrl: '172.30.0.19:41234',
};
const PLATFORM_DOCUMENT = {
  networks: { 'dsh-team-net-7': { IPAddress: '172.30.0.19' } },
  env: ['PLATFORM_PORT=41234'],
};

/** A canned `docker container inspect` for the employee container and the platform. */
function inspections(
  employee: unknown,
  result: (stdout: string) => DockerCommandResult = (stdout) => ({ status: 0, stdout, stderr: '' }),
) {
  const calls: (readonly string[])[] = [];
  const run: AsyncDockerCommand = (args) => {
    calls.push(args);
    if (args.at(-1) === 'dsh-team-platform')
      return Promise.resolve({ status: 0, stdout: JSON.stringify(PLATFORM_DOCUMENT), stderr: '' });
    const stdout = typeof employee === 'string' ? employee : `${JSON.stringify(employee)}\n`;
    return Promise.resolve(result(stdout));
  };
  return { calls, run };
}

it('builds the needles from the instance token, the platform endpoint and the stack', async () => {
  const { calls, run } = inspections([
    'PATH=/usr/bin',
    `DSH_TEAM_INSTANCE_TOKEN=${TOKEN}`,
    'DSH_TEAM_MODEL_API_KEY=model-nonce',
  ]);
  const stack = { ragflowUrl: 'http://127.0.0.1:9380', ragflowApiKey: 'ragflow-key-nonce' };

  await expect(panelNeedles(run, '7', stack)).resolves.toEqual(NEEDLES);
  expect(calls.map((args) => args.at(-1))).toEqual(['dsh-team-u-7', 'dsh-team-platform']);
  expect(calls[0]).toEqual([
    'container',
    'inspect',
    '--format',
    '{{json .Config.Env}}',
    'dsh-team-u-7',
  ]);
});

it.each([
  ['no token', ['PATH=/usr/bin']],
  ['a short token', [`DSH_TEAM_INSTANCE_TOKEN=${'b'.repeat(63)}`]],
  ['an uppercase token', [`DSH_TEAM_INSTANCE_TOKEN=${'B'.repeat(64)}`]],
  ['two tokens', [`DSH_TEAM_INSTANCE_TOKEN=${TOKEN}`, `DSH_TEAM_INSTANCE_TOKEN=${'c'.repeat(64)}`]],
  ['a non-array environment', { DSH_TEAM_INSTANCE_TOKEN: TOKEN }],
])('refuses the needles with %s, without echoing the environment', async (_label, env) => {
  const { run } = inspections(env);
  const stack = { ragflowUrl: 'http://127.0.0.1:9380', ragflowApiKey: 'ragflow-key-nonce' };

  await expect(panelNeedles(run, '7', stack)).rejects.toThrow(/^Instance token unavailable$/);
});

const ENVIRONMENT = `["DSH_TEAM_INSTANCE_TOKEN=${TOKEN}","DSH_TEAM_MODEL_API_KEY=model-nonce"]`;
it.each([
  [
    'a command error after a partial write',
    inspections(ENVIRONMENT.slice(0, -2), (stdout) => ({
      status: null,
      stdout,
      stderr: stdout,
      error: new Error(`spawnSync docker ENOBUFS ${stdout}`),
    })),
  ],
  ['a nonzero status', inspections(ENVIRONMENT, (stdout) => ({ status: 1, stdout, stderr: '' }))],
  ['malformed JSON', inspections(`${ENVIRONMENT.slice(0, -1)},`)],
])(
  'reports %s as the fixed token failure, without the environment or a cause',
  async (_label, { calls, run }) => {
    const stack = { ragflowUrl: 'http://127.0.0.1:9380', ragflowApiKey: 'ragflow-key-nonce' };
    const error: unknown = await panelNeedles(run, '7', stack).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Instance token unavailable');
    expect((error as Error).cause).toBeUndefined();
    for (const secret of [TOKEN, 'model-nonce', 'DSH_TEAM_INSTANCE_TOKEN'])
      expect(String(error)).not.toContain(secret);
    expect(calls.map((args) => args.at(-1))).toEqual(['dsh-team-u-7']);
  },
);

/** A Playwright-like response; `body` rejects when `bytes` is an Error. */
function response(
  path: string,
  type: string,
  bytes: string | Error,
  options: { status?: number; origin?: string } = {},
): ScannedResponse {
  return {
    url: () => `${options.origin ?? BASE}${path}`,
    status: () => options.status ?? 200,
    headers: () => ({ 'content-type': type }),
    body: () =>
      bytes instanceof Error ? Promise.reject(bytes) : Promise.resolve(Buffer.from(bytes)),
  };
}

it.each([
  ['the DSH document', response('/', 'text/html; charset=utf-8', ''), 'html'],
  ['a combined plugin script', response('/plugins/??a,b', 'application/javascript', ''), 'script'],
  ['an asset script', response('/assets/index-abc.js', 'text/javascript', ''), 'script'],
  [
    'the datasets route',
    response('/api/knowledge-base.datasets', 'application/json', ''),
    'panel-route',
  ],
  [
    'the documents route',
    response('/api/knowledge-base.documents?page=1', 'application/json', ''),
    'panel-route',
  ],
  [
    'the chunks route',
    response('/api/knowledge-base.chunks?page=1', 'application/json', ''),
    'panel-route',
  ],
  ['a platform page', response('/_platform/login', 'text/html', ''), undefined],
  ['a platform script', response('/_platform/assets/a.js', 'text/javascript', ''), undefined],
  ['the event stream', response('/plugins/events', 'text/event-stream', ''), undefined],
  ['a redirect', response('/', 'text/html', '', { status: 302 }), undefined],
  [
    'a failed panel route answer',
    response('/api/knowledge-base.datasets', 'text/plain', '', { status: 500 }),
    'panel-route',
  ],
  ['a foreign origin', response('/', 'text/html', '', { origin: 'http://127.0.0.1:1' }), undefined],
  ['a stylesheet', response('/assets/index.css', 'text/css', ''), undefined],
  ['another API answer', response('/api/session', 'application/json', ''), undefined],
])('classifies %s', (_label, observed, kind) => {
  expect(scannedKind(observed, BASE)).toBe(kind);
});

const HTML = '<script>globalThis["__DSH_TEAM_KNOWLEDGE_BASE__"] = {"available":true}</script>';
const CLIENT = "h('div', { 'data-dsh-team-kb-page': '' })";
const CLEAN: ResourceScan = {
  html: 1,
  clientScripts: 1,
  panelRoutes: 1,
  matches: [],
  unreadable: [],
};

/** The three positive-control resources, each carrying `extra`. */
function sessionResponses(extra: Partial<Record<'html' | 'script' | 'route', string>> = {}) {
  return [
    response('/', 'text/html', HTML + (extra.html ?? '')),
    response('/plugins/??kb', 'application/javascript', CLIENT + (extra.script ?? '')),
    response(
      '/api/knowledge-base.datasets',
      'application/json',
      `{"result":"ok"}${extra.route ?? ''}`,
    ),
  ];
}

it('settles a clean session with each positive control and no match', async () => {
  const scan = resourceScan(BASE, NEEDLES);
  for (const observed of sessionResponses()) scan.onResponse(observed);
  scan.onResponse(response('/_platform/login', 'text/html', NEEDLES.ragflowApiKey));

  const settled = await scan.settle();
  expect(settled).toEqual(CLEAN);
  expectNoPanelSecrets(settled);
});

it.each(Object.keys(NEEDLES) as (keyof PanelNeedles)[])(
  'names only the needle kind and path when a body carries %s',
  async (needle) => {
    const value = NEEDLES[needle];
    const scan = resourceScan(BASE, NEEDLES);
    for (const observed of sessionResponses({ html: value, script: `x${value}x`, route: value }))
      scan.onResponse(observed);

    const settled = await scan.settle();
    expect(settled.matches).toEqual([
      `${needle} /`,
      `${needle} /plugins/`,
      `${needle} /api/knowledge-base.datasets`,
    ]);
    let failure: unknown;
    try {
      expectNoPanelSecrets(settled);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      `Panel page resources carry a secret: ${settled.matches.join(', ')}`,
    );
    expect((failure as Error).message).not.toContain(value);
  },
);

it('fails a session whose scanned body could not be read', async () => {
  const scan = resourceScan(BASE, NEEDLES);
  for (const observed of sessionResponses()) scan.onResponse(observed);
  scan.onResponse(response('/assets/late.js', 'text/javascript', new Error('No resource')));

  const settled = await scan.settle();
  expect(settled.unreadable).toEqual(['/assets/late.js']);
  expect(() => {
    expectNoPanelSecrets(settled);
  }).toThrow(/^Panel page resources left unread: \/assets\/late\.js$/);
});

it('ignores responses that arrive after the scan settled', async () => {
  const scan = resourceScan(BASE, NEEDLES);
  for (const observed of sessionResponses()) scan.onResponse(observed);
  const settled = scan.settle();
  scan.onResponse(response('/', 'text/html', NEEDLES.instanceToken));

  await expect(settled).resolves.toEqual(CLEAN);
});

it.each([
  [
    'no DSH document with the global',
    { ...CLEAN, html: 0 },
    'DSH documents with the knowledge-base global',
  ],
  [
    'no knowledge-base client script',
    { ...CLEAN, clientScripts: 0 },
    'scripts with the knowledge-base client',
  ],
  ['no panel route answer', { ...CLEAN, panelRoutes: 0 }, 'knowledge-base route answers'],
])('fails a scan with %s', (_label, scan, message) => {
  expect(() => {
    expectNoPanelSecrets(scan);
  }).toThrow(message);
});

it('does not count a document without the global or a script without the client', async () => {
  const scan = resourceScan(BASE, NEEDLES);
  scan.onResponse(response('/', 'text/html', '<html></html>'));
  scan.onResponse(response('/plugins/??other', 'application/javascript', 'other plugin'));
  scan.onResponse(response('/api/knowledge-base.documents', 'application/json', '{}'));

  await expect(scan.settle()).resolves.toEqual({ ...CLEAN, html: 0, clientScripts: 0 });
});

it('reports a needle in a panel route answer whatever its status', async () => {
  const scan = resourceScan(BASE, NEEDLES);
  for (const observed of sessionResponses()) scan.onResponse(observed);
  const failed = `{"error":"${NEEDLES.instanceToken}"}`;
  scan.onResponse(
    response('/api/knowledge-base.documents', 'application/json', failed, { status: 502 }),
  );
  scan.onResponse(
    response('/assets/a.js', 'text/javascript', NEEDLES.instanceToken, { status: 404 }),
  );

  const settled = await scan.settle();
  expect(settled.matches).toEqual(['instanceToken /api/knowledge-base.documents']);
  expect(settled.panelRoutes).toBe(2);
});

const PREVIEWED: PanelSnapshot = {
  ...LISTED,
  preview: { state: 'list', name: 'expense-policy.txt', chunks: ['一、费用报销。', '二、报销。'] },
};

it('accepts a snapshot with an open preview and records the preview state as the step state', () => {
  expect(panelSnapshot(PREVIEWED)).toEqual(PREVIEWED);
  const failed: PanelSnapshot = { ...LISTED, preview: { state: 'failed', name: 'a', chunks: [] } };
  expect(panelStep('preview-unavailable', failed, 'kb-preview-unavailable')).toEqual({
    step: 'preview-unavailable',
    state: 'failed',
    datasets: 1,
    files: 1,
    screenshot: 'kb-preview-unavailable.png',
  });
});

it.each([
  ['a null preview', { ...LISTED, preview: null }],
  ['an unknown preview state', { ...LISTED, preview: { state: 'open', name: 'a', chunks: [] } }],
  ['a non-string preview name', { ...LISTED, preview: { state: 'list', name: 1, chunks: [] } }],
  ['non-string chunks', { ...LISTED, preview: { state: 'list', name: 'a', chunks: [1] } }],
])('rejects a snapshot with %s', (_label, value) => {
  expect(() => panelSnapshot(value)).toThrow('Knowledge panel snapshot malformed');
});

it('waits for a loading preview like any other region', async () => {
  const loading: PanelSnapshot = {
    ...LISTED,
    loading: 1,
    preview: { state: 'loading', name: 'a', chunks: [] },
  };
  const observed = [loading, PREVIEWED];
  let reads = 0;

  await expect(
    settledPanel(() => Promise.resolve(observed[reads++] ?? PREVIEWED), 5_000),
  ).resolves.toEqual(PREVIEWED);
  expect(reads).toBe(2);
});

const CLEAN_BROWSER: StackBrowserEvidence = {
  screenshots: [],
  consoleErrors: [],
  unloadViolations: [],
  pageErrors: [],
  failedRequests: [],
  externalRequests: [],
  requests: 1,
  websockets: 1,
};
const step = (name: string, state: PanelStep['state'], files: number): PanelStep => ({
  step: name,
  state,
  datasets: 3,
  files,
  screenshot: `kb-${name}.png`,
});
/** The three panel sessions as the stack lane records them, in order. */
function panelSessions(): PanelSessionEvidence[] {
  const restored = [
    step('datasets', 'list', 0),
    step('files', 'list', 2),
    step('filter', 'list', 1),
    step('preview', 'list', 1),
    step('preview-unavailable', 'failed', 1),
    step('no-match', 'no-match', 0),
  ];
  return [
    [step('not-configured', 'not-configured', 0)],
    [step('unavailable', 'failed', 0)],
    restored,
  ].map((steps) => ({
    browser: { ...CLEAN_BROWSER, screenshots: steps.map(({ screenshot }) => screenshot) },
    steps,
  }));
}

it('accepts the three panel sessions in order and returns their steps and screenshots', () => {
  const sessions = panelSessions();

  const evidence = expectPanelEvidence(sessions);

  expect(evidence.steps).toEqual(sessions.flatMap(({ steps }) => steps));
  expect(evidence.screenshots).toEqual([
    'kb-not-configured.png',
    'kb-unavailable.png',
    'kb-datasets.png',
    'kb-files.png',
    'kb-filter.png',
    'kb-preview.png',
    'kb-preview-unavailable.png',
    'kb-no-match.png',
  ]);
});

it.each([
  [
    'a missing preview step',
    (sessions: PanelSessionEvidence[]) => {
      const [first, second, restored] = sessions;
      if (first === undefined || second === undefined || restored === undefined) return sessions;
      const steps = restored.steps.filter(({ step: name }) => name !== 'preview');
      const screenshots = steps.map(({ screenshot }) => screenshot);
      return [first, second, { browser: { ...restored.browser, screenshots }, steps }];
    },
  ],
  [
    'the preview steps swapped',
    (sessions: PanelSessionEvidence[]) => {
      const [first, second, restored] = sessions;
      if (first === undefined || second === undefined || restored === undefined) return sessions;
      const [a, b, c, d, e, f] = restored.steps;
      if ([a, b, c, d, e, f].includes(undefined)) return sessions;
      const steps = [a, b, c, e, d, f] as PanelStep[];
      const screenshots = steps.map(({ screenshot }) => screenshot);
      return [first, second, { browser: { ...restored.browser, screenshots }, steps }];
    },
  ],
  [
    'a preview that counts another file',
    (sessions: PanelSessionEvidence[]) =>
      sessions.map((session) => ({
        ...session,
        steps: session.steps.map((entry) =>
          entry.step === 'preview' ? { ...entry, files: 2 } : entry,
        ),
      })),
  ],
  [
    'a screenshot the steps do not name',
    (sessions: PanelSessionEvidence[]) =>
      sessions.map((session, index) =>
        index === 2
          ? {
              ...session,
              browser: {
                ...session.browser,
                screenshots: [...session.browser.screenshots, 'kb-extra.png'],
              },
            }
          : session,
      ),
  ],
  [
    'a console error in the restored session',
    (sessions: PanelSessionEvidence[]) =>
      sessions.map((session, index) =>
        index === 2
          ? { ...session, browser: { ...session.browser, consoleErrors: ['boom'] } }
          : session,
      ),
  ],
  [
    'a failed request in the not-configured session',
    (sessions: PanelSessionEvidence[]) =>
      sessions.map((session, index) =>
        index === 0
          ? { ...session, browser: { ...session.browser, failedRequests: ['GET /x'] } }
          : session,
      ),
  ],
  [
    'an external request in the unavailable session',
    (sessions: PanelSessionEvidence[]) =>
      sessions.map((session, index) =>
        index === 1
          ? { ...session, browser: { ...session.browser, externalRequests: ['http://x/'] } }
          : session,
      ),
  ],
])('fails the panel evidence with %s', (_label, change) => {
  // An assertion failure, not a type error: the helper itself rejects the evidence.
  expect(() => expectPanelEvidence(change(panelSessions()))).toThrow(/^expected /);
});
