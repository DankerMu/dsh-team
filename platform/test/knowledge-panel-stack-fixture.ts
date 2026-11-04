import { randomUUID } from 'node:crypto';
import type { Page, Response } from '@playwright/test';
import { expect } from 'vitest';
import { SEED_DATASETS } from '../../scripts/seed-stack.mjs';
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

/** One observed workbench session that opens the 「知识库」 panel and runs `script` on it. */
async function panelSession(
  session: StackSession,
  label: string,
  script: (panel: PanelDriver) => Promise<void>,
): Promise<PanelSessionEvidence> {
  let steps: readonly PanelStep[] = [];
  const browser = await workbenchSession(
    session,
    { label: `knowledge panel ${label}`, failure: `kb-${label}-failure` },
    async (page, shoot) => {
      const panel = panelDriver(page, shoot, session.timeout);
      steps = panel.steps;
      await script(panel.driver);
    },
  );
  return { browser, steps };
}

/** Before RAGFlow is configured: 「知识库未配置」, with no list and no retry. */
export function notConfiguredPanel(session: StackSession) {
  return panelSession(session, 'not-configured', async (panel) => {
    const opened = await panel.open();
    expect(opened.datasets).toMatchObject({ state: 'not-configured', names: [] });
    expect(opened.datasets?.text).toContain('知识库未配置');
    expect(opened.buttons).not.toContain('重试');
    await panel.record('not-configured', opened, 'kb-not-configured');
  });
}

/** While RAGFlow is stopped: a retryable failure, and the retry fails again. */
export function unavailablePanel(session: StackSession) {
  return panelSession(session, 'unavailable', async (panel) => {
    const opened = await panel.open();
    expect(opened.datasets?.state).toBe('failed');
    expect(opened.buttons).toContain('重试');
    const retried = await panel.answered('datasets', panel.button('重试'));
    expect(retried.datasets?.state).toBe('failed');
    await panel.record('unavailable', retried, 'kb-unavailable');
  });
}

/** After RAGFlow is back: seed libraries, one library's files, a file filter and a no-match search. */
export function restoredPanel(session: StackSession) {
  return panelSession(session, 'restored', async (panel) => {
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
