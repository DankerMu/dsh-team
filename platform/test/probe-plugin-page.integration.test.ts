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
// The catalog's four packages and image defaults: only the office bundle is selected.
const EXPECTED = [
  { package: PACKAGE, enabled: true },
  { package: '@dsh-team/permission-tiers', enabled: false },
  { package: '@dsh-team/platform-nav', enabled: false },
  { package: '@dsh-team/zh-locale', enabled: false },
];
const PANEL = 'button[aria-label="插件"]';
const OPEN = `[data-plugin-package="${PACKAGE}"] button[aria-label="查看 ${PACKAGE}"]`;
const SWITCH = `button[role="switch"][aria-label="启用 ${PACKAGE}"]`;

interface FakeCard {
  absent?: boolean;
  group?: string;
  status?: 'running' | 'disabled' | 'problem';
  checked?: boolean;
}

interface FakeOptions {
  /** The saved state of the office bundle when the page first loads (default on). */
  officeEnabled?: boolean;
  /** Per-package card overrides; by default each card follows its saved state. */
  cards?: Record<string, FakeCard>;
  /** The header lacks the released 「添加插件」 button. */
  noAddButton?: boolean;
  /** The detail lacks the released 「卸载」 button. */
  noUninstallButton?: boolean;
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
    saved: options.officeEnabled ?? true,
    shown: options.officeEnabled ?? true,
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
    loaded && (state.detail || options.cards?.[PACKAGE]?.absent !== true)
      ? {
          checked: String(state.shown),
          disabled: busy || options.locked === true,
          title: options.locked === true ? '插件管理所需，不能停用或卸载' : null,
          inDetail: state.detail,
          inCard: !state.detail,
        }
      : null;
  // DSH renders every listed package as a card in the 已安装 group: running when selected.
  const cards = (listed: boolean) =>
    EXPECTED.map(({ package: name }) => {
      const enabled = name === PACKAGE && state.shown;
      const card = {
        group: 'bundles',
        status: enabled ? 'running' : 'disabled',
        ...options.cards?.[name],
      };
      const present = listed && card.absent !== true;
      return {
        package: name,
        present,
        group: present ? card.group : null,
        status: present ? card.status : null,
        checked: present ? String(card.checked ?? enabled) : null,
      };
    });
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
      cards: cards(loaded && listed),
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

async function run(
  options: FakeOptions,
  ms = 3_000,
  pluginPage = { expected: EXPECTED, roundTrip: { package: PACKAGE, leaveEnabled: true } },
) {
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
    ...pluginPage,
  });
  return { result, state, root };
}

const shots = (root: string, ...names: string[]) =>
  names.map((name) => ({ screenshot: join(root, `entry-plugin-page-${name}.png`), bytes: 3 }));
const cardsWith = (office: { status: string; checked: boolean }) =>
  EXPECTED.map(({ package: name }) =>
    name === PACKAGE
      ? { package: name, ...office }
      : { package: name, status: 'disabled', checked: false },
  );

it('accepts a page with install entries whose switch round-trips across reloads', async () => {
  const { result, state, root } = await run({});

  const evidence = await result;

  expect(evidence).toEqual({
    list: { refresh: true, addButtons: 1, group: 'bundles', status: 'running', checked: true },
    detail: { uninstallButtons: 1, checked: true, disabled: false, title: null },
    off: { checked: false, status: 'disabled' },
    on: { checked: true, status: 'running' },
    cards: cardsWith({ status: 'running', checked: true }),
    screenshots: shots(root, 'list', 'detail', 'off', 'on'),
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

it('leaves the bundle switched off when the round trip says so', async () => {
  const { result, state, root } = await run({}, 3_000, {
    expected: EXPECTED,
    roundTrip: { package: PACKAGE, leaveEnabled: false },
  });

  const evidence = await result;

  expect(evidence).toEqual({
    list: { refresh: true, addButtons: 1, group: 'bundles', status: 'running', checked: true },
    detail: { uninstallButtons: 1, checked: true, disabled: false, title: null },
    off: { checked: false, status: 'disabled' },
    cards: cardsWith({ status: 'running', checked: true }),
    screenshots: shots(root, 'list', 'detail', 'off'),
  });
  expect(state.clicks).toEqual([PANEL, OPEN, SWITCH, PANEL]);
  expect(state.saved).toBe(false);
});

it('starts from a disabled bundle when the catalog state says so, and switches it back on', async () => {
  const expected = EXPECTED.map((entry) => ({ ...entry, enabled: false }));
  const { result, state, root } = await run({ officeEnabled: false }, 3_000, {
    expected,
    roundTrip: { package: PACKAGE, leaveEnabled: true },
  });

  const evidence = await result;

  expect(evidence).toEqual({
    list: { refresh: true, addButtons: 1, group: 'bundles', status: 'disabled', checked: false },
    detail: { uninstallButtons: 1, checked: false, disabled: false, title: null },
    on: { checked: true, status: 'running' },
    cards: cardsWith({ status: 'disabled', checked: false }),
    screenshots: shots(root, 'list', 'detail', 'on'),
  });
  expect(state.clicks).toEqual([PANEL, OPEN, SWITCH, PANEL]);
  expect(state.saved).toBe(true);
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
  [
    'a card outside the 已安装 group',
    { cards: { [PACKAGE]: { group: 'official' } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'a missing catalog card',
    { cards: { '@dsh-team/platform-nav': { absent: true } } },
    /stage=plugin-page-list error=catalog-card observed=.*"package":"@dsh-team\/platform-nav","present":false/,
  ],
  [
    'a missing round-trip card',
    { cards: { [PACKAGE]: { absent: true } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'a catalog card with a problem',
    { cards: { '@dsh-team/zh-locale': { status: 'problem' } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'a required plugin shown running',
    { cards: { '@dsh-team/permission-tiers': { status: 'running', checked: true } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'the office bundle shown disabled',
    { officeEnabled: false },
    /stage=plugin-page-list error=catalog-card/,
  ],
  ['a locked switch', { locked: true }, /stage=plugin-page-list/],
  ['a toolbar without refresh', { noRefresh: true }, /stage=plugin-page-list/],
  ['a switch change that a reload forgets', { forgets: true }, /stage=plugin-page-off/],
  ['a console error while switched off', { errorWhenOff: true }, /error=console count=1/],
  ['a panel row that never renders', { latePanel: 1_000 }, /stage=plugin-page-list error=panel/],
])('rejects %s', async (_name, options, failure) => {
  const { result } = await run(options, 600);

  await expect(result).rejects.toThrow(failure);
});

it.each<[string, Record<string, unknown>]>([
  ['no catalog table', { roundTrip: { package: PACKAGE, leaveEnabled: true } }],
  [
    'a round trip outside the catalog table',
    { expected: EXPECTED, roundTrip: { package: '@x/other', leaveEnabled: true } },
  ],
  ['no final state', { expected: EXPECTED, roundTrip: { package: PACKAGE } }],
])('rejects options with %s before touching the page', async (_name, pluginPage) => {
  const { result, state } = await run({}, 600, pluginPage as never);

  await expect(result).rejects.toThrow(/^stage=plugin-page error=options$/);
  expect(state.clicks).toEqual([]);
});
