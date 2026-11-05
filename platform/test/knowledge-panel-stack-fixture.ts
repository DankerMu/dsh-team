import { randomUUID } from 'node:crypto';
import type { Page, Response } from '@playwright/test';
import { expect } from 'vitest';
import { SEED_DATASETS } from '../../scripts/seed-stack.mjs';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import { instancePlatformEndpoint, platformRagflowUrl } from './ragflow-stack-fixture.ts';
import { until, workbenchSession } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence, StackSession } from './stack-browser-fixture.ts';

// The released 0.2.1-rc.2 sidebar PanelRow names its button by the row label.
const ENTRY = 'button[aria-label="知识库"]';
const STATES = ['loading', 'not-configured', 'failed', 'empty', 'no-match', 'list'] as const;
type PanelState = (typeof STATES)[number];
const POLICIES = 'dsh-team-seed-policies';

/** What the panel shows, read in the page; the root config has no DOM lib. */
export interface PanelSnapshot {
  /** Regions whose state is still `loading`, the list and every expanded library. */
  readonly loading: number;
  /** Every button text on the panel page. */
  readonly buttons: readonly string[];
  readonly datasets: { state: PanelState; text: string; names: readonly string[] } | null;
  readonly files: readonly { state: PanelState; names: readonly string[]; hint: boolean }[];
}

const SNAPSHOT = `(() => {
  const text = (node) => (node.textContent || '').trim();
  const page = document.querySelector('[data-dsh-team-kb-page]');
  const list = document.querySelector('[data-dsh-team-kb-datasets]');
  return {
    loading: document.querySelectorAll('[data-dsh-team-kb-state="loading"]').length,
    buttons: page === null ? [] : [...page.querySelectorAll('button')].map(text),
    datasets: list === null ? null : {
      state: list.getAttribute('data-dsh-team-kb-state'),
      text: text(list),
      names: [...list.querySelectorAll('[data-dsh-team-kb-dataset] > button')].map(text),
    },
    files: [...document.querySelectorAll('[data-dsh-team-kb-files]')].map((region) => ({
      state: region.getAttribute('data-dsh-team-kb-state'),
      names: [...region.querySelectorAll('[data-dsh-team-kb-file]')].map(text),
      hint: region.querySelector('[data-dsh-team-kb-hint]') !== null,
    })),
  };
})()`;

const MALFORMED = 'Knowledge panel snapshot malformed';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isState = (value: unknown): value is PanelState =>
  typeof value === 'string' && (STATES as readonly string[]).includes(value);
function texts(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new Error(MALFORMED);
  return value;
}
function region(value: unknown): Record<string, unknown> & { state: PanelState } {
  if (!isRecord(value) || !isState(value.state)) throw new Error(MALFORMED);
  return { ...value, state: value.state };
}
/** The in-page snapshot, checked field by field; anything else fails the session. */
export function panelSnapshot(value: unknown): PanelSnapshot {
  if (!isRecord(value) || !Number.isSafeInteger(value.loading) || Number(value.loading) < 0)
    throw new Error(MALFORMED);
  let datasets: PanelSnapshot['datasets'] = null;
  if (value.datasets !== null) {
    const list = region(value.datasets);
    if (typeof list.text !== 'string') throw new Error(MALFORMED);
    datasets = { state: list.state, text: list.text, names: texts(list.names) };
  }
  if (!Array.isArray(value.files)) throw new Error(MALFORMED);
  const files = value.files.map((item: unknown) => {
    const files = region(item);
    if (typeof files.hint !== 'boolean') throw new Error(MALFORMED);
    return { state: files.state, names: texts(files.names), hint: files.hint };
  });
  return { loading: Number(value.loading), buttons: texts(value.buttons), datasets, files };
}

/**
 * Polls until the panel page is open and no region is loading. Every action waits for this
 * first: Playwright counts an aborted in-flight request as a failed request.
 */
export async function settledPanel(
  read: () => Promise<PanelSnapshot>,
  timeout: number,
): Promise<PanelSnapshot> {
  const seen: { latest?: PanelSnapshot } = {};
  await until(
    async () => {
      const latest = await read();
      seen.latest = latest;
      return latest.datasets !== null && latest.loading === 0;
    },
    timeout,
    'knowledge panel settled',
  );
  if (seen.latest === undefined) throw new Error('Knowledge panel never read');
  return seen.latest;
}

/** One step's evidence: state name, listed library and file counts, screenshot name. */
export interface PanelStep {
  readonly step: string;
  readonly state: PanelState;
  readonly datasets: number;
  readonly files: number;
  readonly screenshot: string;
}

export function panelStep(step: string, snapshot: PanelSnapshot, screenshot: string): PanelStep {
  if (snapshot.datasets === null) throw new Error('Knowledge panel not open');
  return {
    step,
    state: snapshot.datasets.state,
    datasets: snapshot.datasets.names.length,
    files: snapshot.files.reduce((count, { names }) => count + names.length, 0),
    screenshot: `${screenshot}.png`,
  };
}

/** The panel actions a session script uses; each returns the settled panel afterwards. */
interface PanelDriver {
  open(): Promise<PanelSnapshot>;
  /** Clicks a panel button and waits for its route answer, then for the panel to settle. */
  answered(route: 'datasets' | 'documents', click: () => Promise<void>): Promise<PanelSnapshot>;
  button(name: string): () => Promise<void>;
  filter(text: string): () => Promise<void>;
  search(text: string): Promise<PanelSnapshot>;
  record(step: string, snapshot: PanelSnapshot, screenshot: string): Promise<void>;
}

export interface PanelSessionEvidence {
  readonly browser: StackBrowserEvidence;
  readonly steps: readonly PanelStep[];
}

/** The values no page resource of a panel session may carry; compared in memory, never printed. */
export interface PanelNeedles {
  readonly ragflowApiKey: string;
  readonly ragflowBaseUrl: string;
  readonly instanceToken: string;
  /** The platform's `<instance +3 address>:<port>`, the authority of the overlay's platformUrl. */
  readonly platformUrl: string;
}

const NEEDLE_KINDS = ['ragflowApiKey', 'ragflowBaseUrl', 'instanceToken', 'platformUrl'] as const;
const TOKEN_VARIABLE = /^DSH_TEAM_INSTANCE_TOKEN=([0-9a-f]{64})$/;

/**
 * The needles for one employee's panel session, read while its instance runs (the token changes
 * with every start). The token and RAGFlow key stay in this process's memory; a missing or
 * malformed token fails with a fixed message.
 */
export async function panelNeedles(
  run: DockerOutput,
  employeeId: string,
  stack: { readonly ragflowUrl: string; readonly ragflowApiKey: string },
): Promise<PanelNeedles> {
  const env: unknown = JSON.parse(
    await run([
      'container',
      'inspect',
      '--format',
      '{{json .Config.Env}}',
      `dsh-team-u-${employeeId}`,
    ]),
  );
  const tokens = (Array.isArray(env) ? env : []).flatMap((entry: unknown) => {
    const match = typeof entry === 'string' ? TOKEN_VARIABLE.exec(entry) : null;
    return match?.[1] === undefined ? [] : [match[1]];
  });
  const [instanceToken] = tokens;
  if (tokens.length !== 1 || instanceToken === undefined)
    throw new Error('Instance token unavailable');
  const { host, port } = await instancePlatformEndpoint(run, employeeId);
  return {
    ragflowApiKey: stack.ragflowApiKey,
    ragflowBaseUrl: platformRagflowUrl(stack.ragflowUrl),
    instanceToken,
    platformUrl: `${host}:${String(port)}`,
  };
}

/** What a session's resource scan reads of one Playwright response. */
export type ScannedResponse = Pick<Response, 'url' | 'status' | 'headers' | 'body'>;
type ScannedKind = 'html' | 'script' | 'panel-route';
const PANEL_ROUTES = new Set(['/api/knowledge-base.datasets', '/api/knowledge-base.documents']);

/**
 * Same-origin 200 bodies a panel session scans: the panel routes, and the DSH documents and
 * scripts. Platform pages are left out (a navigated-away login document may lose its body), and so
 * is the event stream, whose body never completes.
 */
export function scannedKind(response: ScannedResponse, base: string): ScannedKind | undefined {
  const url = new URL(response.url());
  if (url.origin !== new URL(base).origin || response.status() !== 200) return undefined;
  if (PANEL_ROUTES.has(url.pathname)) return 'panel-route';
  if (url.pathname === '/_platform' || url.pathname.startsWith('/_platform/')) return undefined;
  const type = response.headers()['content-type'] ?? '';
  if (/^text\/event-stream/i.test(type)) return undefined;
  if (/^text\/html/i.test(type)) return 'html';
  return /javascript/i.test(type) ? 'script' : undefined;
}

// The host half publishes its page global into the DSH document; only client.js renders the page.
const HTML_MARKER = '__DSH_TEAM_KNOWLEDGE_BASE__';
const CLIENT_MARKER = 'data-dsh-team-kb-page';

/** What a settled scan found: positive-control counts, and needle kinds by URL path only. */
export interface ResourceScan {
  /** DSH documents carrying the knowledge-base page global. */
  readonly html: number;
  /** Scripts carrying the knowledge-base client. */
  readonly clientScripts: number;
  readonly panelRoutes: number;
  /** `<needle kind> <path>` for every match; never the needle or the body. */
  readonly matches: readonly string[];
  /** Paths of scanned kinds whose body could not be read. */
  readonly unreadable: readonly string[];
}

/** Collects the scanned bodies of one session; `settle` must run while the browser is open. */
export function resourceScan(base: string, needles: PanelNeedles) {
  const found = { html: 0, clientScripts: 0, panelRoutes: 0 };
  const matches: string[] = [];
  const unreadable: string[] = [];
  const pending: Promise<void>[] = [];
  let accepting = true;
  const scan = (kind: ScannedKind, path: string, body: Buffer) => {
    if (kind === 'html' && body.includes(HTML_MARKER)) found.html++;
    if (kind === 'script' && body.includes(CLIENT_MARKER)) found.clientScripts++;
    if (kind === 'panel-route') found.panelRoutes++;
    for (const needle of NEEDLE_KINDS)
      if (body.includes(needles[needle])) matches.push(`${needle} ${path}`);
  };
  return {
    onResponse: (response: ScannedResponse) => {
      const kind = accepting ? scannedKind(response, base) : undefined;
      if (kind === undefined) return;
      const path = new URL(response.url()).pathname;
      pending.push(
        response.body().then(
          (body) => {
            scan(kind, path, body);
          },
          () => {
            unreadable.push(path);
          },
        ),
      );
    },
    async settle(): Promise<ResourceScan> {
      accepting = false;
      await Promise.all(pending);
      return { ...found, matches, unreadable };
    },
  };
}

/**
 * No scanned body carries a needle, and the scan saw the DSH document with the page global, the
 * knowledge-base client script and at least one panel route answer. Messages name only needle
 * kinds and paths.
 */
export function expectNoPanelSecrets(scan: ResourceScan): void {
  // Explicit messages: an assertion diff would truncate the list.
  if (scan.matches.length > 0)
    throw new Error(`Panel page resources carry a secret: ${scan.matches.join(', ')}`);
  if (scan.unreadable.length > 0)
    throw new Error(`Panel page resources left unread: ${scan.unreadable.join(', ')}`);
  expect(scan.html, 'DSH documents with the knowledge-base global').toBeGreaterThan(0);
  expect(scan.clientScripts, 'scripts with the knowledge-base client').toBeGreaterThan(0);
  expect(scan.panelRoutes, 'knowledge-base route answers').toBeGreaterThan(0);
}

const routeAnswer = (route: string) => (response: Response) =>
  new URL(response.url()).pathname === `/api/knowledge-base.${route}`;

function panelDriver(page: Page, shoot: (name: string) => Promise<void>, timeout: number) {
  const steps: PanelStep[] = [];
  const settle = () =>
    settledPanel(async () => panelSnapshot(await page.evaluate<unknown>(SNAPSHOT)), timeout);
  const driver: PanelDriver = {
    async open() {
      await page.locator(ENTRY).first().click();
      return settle();
    },
    async answered(route, click) {
      await Promise.all([page.waitForResponse(routeAnswer(route), { timeout }), click()]);
      return settle();
    },
    button: (name) => () =>
      page.locator('[data-dsh-team-kb-page]').getByRole('button', { name, exact: true }).click(),
    filter: (text) => async () => {
      const field = page.locator('[data-dsh-team-kb-files] input[aria-label="按文件名筛选"]');
      await field.fill(text);
      await field.press('Enter');
    },
    async search(text) {
      await page.locator('input[aria-label="按库名搜索"]').fill(text);
      return settle();
    },
    async record(step, snapshot, screenshot) {
      await shoot(screenshot);
      steps.push(panelStep(step, snapshot, screenshot));
    },
  };
  return { driver, steps };
}

/**
 * One observed workbench session that opens the 「知识库」 panel and runs `script` on it; its
 * page resources are then scanned for `needles` before the browser closes.
 */
async function panelSession(
  session: StackSession,
  label: string,
  needles: PanelNeedles,
  script: (panel: PanelDriver) => Promise<void>,
): Promise<PanelSessionEvidence> {
  let steps: readonly PanelStep[] = [];
  const resources = resourceScan(session.base, needles);
  const browser = await workbenchSession(
    session,
    { label: `knowledge panel ${label}`, failure: `kb-${label}-failure` },
    async (page, shoot) => {
      const panel = panelDriver(page, shoot, session.timeout);
      steps = panel.steps;
      await script(panel.driver);
      expectNoPanelSecrets(await resources.settle());
    },
    undefined,
    resources.onResponse,
  );
  return { browser, steps };
}

/** Before RAGFlow is configured: 「知识库未配置」, with no list and no retry, but 「刷新」. */
export function notConfiguredPanel(session: StackSession, needles: PanelNeedles) {
  return panelSession(session, 'not-configured', needles, async (panel) => {
    const opened = await panel.open();
    expect(opened.datasets).toMatchObject({ state: 'not-configured', names: [] });
    expect(opened.datasets?.text).toContain('知识库未配置');
    expect(opened.buttons).not.toContain('重试');
    expect(opened.buttons).toContain('刷新');
    await panel.record('not-configured', opened, 'kb-not-configured');
  });
}

/** While RAGFlow is stopped: a retryable failure, and the retry fails again. */
export function unavailablePanel(session: StackSession, needles: PanelNeedles) {
  return panelSession(session, 'unavailable', needles, async (panel) => {
    const opened = await panel.open();
    expect(opened.datasets?.state).toBe('failed');
    expect(opened.buttons).toContain('重试');
    const retried = await panel.answered('datasets', panel.button('重试'));
    expect(retried.datasets?.state).toBe('failed');
    await panel.record('unavailable', retried, 'kb-unavailable');
  });
}

/** After RAGFlow is back: seed libraries, one library's files, a file filter and a no-match search. */
export function restoredPanel(session: StackSession, needles: PanelNeedles) {
  return panelSession(session, 'restored', needles, async (panel) => {
    await panel.open();
    const refreshed = await panel.answered('datasets', panel.button('刷新'));
    expect(refreshed.datasets?.state).toBe('list');
    // The local RAGFlow may hold other libraries besides the seed.
    for (const { name } of SEED_DATASETS) expect(refreshed.datasets?.names).toContain(name);
    await panel.record('datasets', refreshed, 'kb-datasets');
    const expanded = await panel.answered('documents', panel.button(POLICIES));
    const policies = SEED_DATASETS.find(({ name }) => name === POLICIES)?.files ?? [];
    expect(expanded.files).toHaveLength(1);
    expect(expanded.files[0]).toMatchObject({ state: 'list', hint: false });
    expect([...(expanded.files[0]?.names ?? [])].sort()).toEqual([...policies].sort());
    await panel.record('files', expanded, 'kb-files');
    const filtered = await panel.answered('documents', panel.filter('expense'));
    expect(filtered.files).toEqual([{ state: 'list', names: ['expense-policy.txt'], hint: false }]);
    await panel.record('filter', filtered, 'kb-filter');
    const searched = await panel.search(`kb-no-match-${randomUUID()}`);
    expect(searched.datasets).toMatchObject({ state: 'no-match', names: [] });
    await panel.record('no-match', searched, 'kb-no-match');
  });
}
