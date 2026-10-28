import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyPluginPage } from '../../scripts/probe-plugin-page.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PACKAGE = '@dsh-team/office-agents';
const PANEL = 'button[aria-label="插件"]';
const OPEN = `[data-plugin-package="${PACKAGE}"] button[aria-label="查看 ${PACKAGE}"]`;
const SWITCH = `button[role="switch"][aria-label="启用 ${PACKAGE}"]`;

interface FakeOptions {
  /** The header lacks the released 「添加插件」 button. */
  noAddButton?: boolean;
  /** The detail lacks the released 「卸载」 button. */
  noUninstallButton?: boolean;
  /** The card is not in the 已安装 group (for example the dependency entry is missing). */
  group?: string;
  status?: 'running' | 'disabled' | 'problem';
  /** The switch carries a readOnlyReason (title) and is locked. */
  locked?: boolean;
  /** A switch change is shown but not saved, so a reload restores the previous state. */
  forgets?: boolean;
  /** No refresh button is rendered in the toolbar. */
  noRefresh?: boolean;
  /** A console error is raised once the bundle is switched off. */
  errorWhenOff?: boolean;
  /** The sidebar panel row renders only after this many click attempts on each page load. */
  latePanel?: number;
}

/** Scripted CDP page answering the evidence module's DOM expressions from released page state. */
function fakePage(options: FakeOptions, errors: unknown[]) {
  const state = {
    panel: false,
    detail: false,
    // Reads until the panel finishes loading after it opens; each change is busy for one read.
    loading: 0,
    busy: 0,
    saved: true,
    shown: true,
    clicks: [] as string[],
    reloads: 0,
    panelAttempts: 0,
  };
  const openPanel = (): boolean => {
    state.panelAttempts += 1;
    if (state.panelAttempts <= (options.latePanel ?? 0)) return false;
    state.panel = true;
    state.loading = 2;
    return true;
  };
  const toggle = (): boolean => {
    if (options.locked === true || state.busy > 0) return false;
    state.shown = !state.shown;
    if (options.forgets !== true) state.saved = state.shown;
    if (!state.shown && options.errorWhenOff === true) errors.push('bundle-off');
    state.busy = 1;
    return true;
  };
  const click = (expression: string): boolean => {
    const selector = /querySelector\(("(?:[^"\\]|\\.)*")\)/.exec(expression)?.[1];
    const text = String(JSON.parse(selector ?? '""'));
    state.clicks.push(text);
    if (text.includes('aria-label="插件"')) return openPanel();
    if (!state.panel || state.loading > 0) return false;
    if (text.includes('查看 ')) {
      if (state.detail) return false;
      state.detail = true;
      return true;
    }
    return text.includes('role="switch"') && toggle();
  };
  const toggleState = (loaded: boolean, busy: boolean) =>
    loaded
      ? {
          checked: String(state.shown),
          disabled: busy || options.locked === true,
          title: options.locked === true ? '插件管理所需，不能停用或卸载' : null,
          inDetail: state.detail,
          inCard: !state.detail,
        }
      : null;
  const cardState = (loaded: boolean) =>
    loaded && !state.detail
      ? {
          group: options.group ?? 'bundles',
          status: options.status ?? (state.shown ? 'running' : 'disabled'),
        }
      : null;
  const observe = () => {
    const loaded = state.panel && state.loading === 0;
    if (state.loading > 0) state.loading -= 1;
    const busy = state.busy > 0;
    if (busy) state.busy -= 1;
    const listed = state.panel && !state.detail;
    return {
      panel: state.panel,
      busy: state.panel ? String(!loaded) : null,
      refresh: listed && options.noRefresh !== true,
      add: listed && options.noAddButton !== true ? 1 : 0,
      uninstall: state.detail && options.noUninstallButton !== true ? 1 : 0,
      card: cardState(loaded),
      detail: loaded && state.detail,
      toggle: toggleState(loaded, busy),
    };
  };
  const reload = (): Promise<void> => {
    state.reloads += 1;
    state.panel = false;
    state.detail = false;
    state.panelAttempts = 0;
    state.shown = state.saved;
    return Promise.resolve();
  };
  return {
    state,
    reload,
    page: {
      send(method: string, params: { expression?: string }) {
        if (method === 'Page.captureScreenshot')
          return Promise.resolve({ data: Buffer.from('png').toString('base64') });
        if (method !== 'Runtime.evaluate') return Promise.reject(new Error(method));
        const expression = params.expression ?? '';
        const value = expression.includes('el.click()') ? click(expression) : observe();
        return Promise.resolve({ result: { value } });
      },
    },
  };
}

async function run(options: FakeOptions, ms = 3_000) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-plugin-page-'));
  roots.push(root);
  const errors: unknown[] = [];
  const { page, state, reload } = fakePage(options, errors);
  const result = verifyPluginPage({
    page,
    errors,
    screenshot: join(root, 'entry.png'),
    ms,
    reload,
  });
  return { result, state, root };
}

it('accepts a page with install entries whose switch round-trips across reloads', async () => {
  const { result, state, root } = await run({});

  const evidence = await result;

  expect(evidence).toEqual({
    list: { refresh: true, addButtons: 1, group: 'bundles', status: 'running', checked: true },
    detail: { uninstallButtons: 1, checked: true, disabled: false, title: null },
    off: { checked: false, status: 'disabled' },
    on: { checked: true, status: 'running' },
    screenshots: [
      { screenshot: join(root, 'entry-plugin-page-list.png'), bytes: 3 },
      { screenshot: join(root, 'entry-plugin-page-detail.png'), bytes: 3 },
      { screenshot: join(root, 'entry-plugin-page-off.png'), bytes: 3 },
      { screenshot: join(root, 'entry-plugin-page-on.png'), bytes: 3 },
    ],
  });
  expect(state.clicks).toEqual([PANEL, OPEN, SWITCH, PANEL, SWITCH, PANEL]);
  expect(state.reloads).toBe(2);
  expect((await readdir(root)).sort()).toEqual([
    'entry-plugin-page-detail.png',
    'entry-plugin-page-list.png',
    'entry-plugin-page-off.png',
    'entry-plugin-page-on.png',
  ]);
});

it('waits for a sidebar panel row that renders after the app is ready', async () => {
  const { result, state } = await run({ latePanel: 2 });

  await expect(result).resolves.toMatchObject({ on: { checked: true, status: 'running' } });
  expect(state.clicks.filter((click) => click === PANEL)).toHaveLength(9);
});

it.each<[string, FakeOptions, RegExp]>([
  ['a list without 添加插件', { noAddButton: true }, /stage=plugin-page-list error=add-plugin/],
  [
    'a detail without 卸载',
    { noUninstallButton: true },
    /stage=plugin-page-detail error=uninstall/,
  ],
  ['a card outside the 已安装 group', { group: 'official' }, /plugin-page-list error=group/],
  ['a card with a problem', { status: 'problem' }, /stage=plugin-page-list error=status/],
  ['a locked switch', { locked: true }, /stage=plugin-page-list/],
  ['a toolbar without refresh', { noRefresh: true }, /stage=plugin-page-list/],
  ['a switch change that a reload forgets', { forgets: true }, /stage=plugin-page-off/],
  ['a console error while switched off', { errorWhenOff: true }, /error=console count=1/],
  ['a panel row that never renders', { latePanel: 1_000 }, /stage=plugin-page-list error=panel/],
])('rejects %s', async (_name, options, failure) => {
  const { result } = await run(options, 600);

  await expect(result).rejects.toThrow(failure);
});
