import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyPluginPage } from '../../scripts/probe-plugin-page.mjs';
import { PROBE_PLUGIN } from './registry-stand-in.ts';

type PluginPageInput = Parameters<typeof verifyPluginPage>[0];

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PACKAGE = '@dsh-team/office-agents';
const TIERS = '@dsh-team/permission-tiers';
const KNOWLEDGE = '@dsh-team/knowledge-base';
type LockState = 'forced-on' | 'forced-off';
// The catalog's five packages and image defaults: the two manageable bundles are selected and
// employee-chosen, and the three required packages are forced on by the administrator catalog.
const EXPECTED: { package: string; enabled: boolean; locked?: LockState }[] = [
  { package: KNOWLEDGE, enabled: true },
  { package: PACKAGE, enabled: true },
  { package: TIERS, enabled: false, locked: 'forced-on' },
  { package: '@dsh-team/platform-nav', enabled: false, locked: 'forced-on' },
  { package: '@dsh-team/zh-locale', enabled: false, locked: 'forced-on' },
];
const PANEL = 'button[aria-label="插件"]';
const OPEN = `[data-plugin-package="${PACKAGE}"] button[aria-label="查看 ${PACKAGE}"]`;
const OPEN_TIERS = `[data-plugin-package="${TIERS}"] button[aria-label="查看 ${TIERS}"]`;
const SWITCH = `button[role="switch"][aria-label="启用 ${PACKAGE}"]`;
const LOCK_TEXT = { 'forced-on': '已开启 · 由管理员设定', 'forced-off': '已关闭 · 由管理员设定' };

interface LockFacts {
  hidden: boolean | null;
  marks: number;
  lock: string | null;
  lockText: string | null;
}

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
  /** Per-package overrides of the card's native-switch rendering and platform lock mark. */
  lockFacts?: Record<string, Partial<LockFacts>>;
  /** Overrides of the locked package's detail top switch rendering and mark. */
  detailLock?: Partial<LockFacts>;
  /** Tab reaches the hidden native switches of locked cards. */
  focusLocked?: boolean;
  /** Tab never reaches the round-trip switch. */
  skipRoundTripFocus?: boolean;
  /** A pointer click on a locked card's mark switches its native bundle selection. */
  lockClickToggles?: boolean;
  /** The lock mark has no rendered box. */
  noMarkBox?: boolean;
  /** The header has no 添加插件 group primary button. */
  noAddGroup?: boolean;
  /** The controlled spec input ignores inserted text. */
  dropsInput?: boolean;
  /** The 安装 precheck refuses the spec (an input error, the dialog stays at its spec). */
  installRefused?: boolean;
  /** pnpm fails: the wizard ends at `failed`. */
  installFails?: boolean;
  /** The finished install names no bundle, so the wizard offers 关闭 instead of 立即启用. */
  installedWithoutBundle?: boolean;
  /** 立即启用 closes the dialog but the card never runs. */
  enableFails?: boolean;
  /** The installed card's group. */
  installedGroup?: string;
  /** A console error is raised when the install finishes. */
  errorOnInstall?: boolean;
  /** The fixture's stand-in preparation rejects. */
  prepareFails?: boolean;
}

type InstallPhase = 'idle' | 'checking' | 'starting' | 'running' | 'done' | 'failed';

const lockedState = (name: string) => EXPECTED.find((entry) => entry.package === name)?.locked;
/** Saved selection of an unlocked card other than the round-trip one: its catalog default. */
const defaultEnabled = (name: string) =>
  EXPECTED.find((entry) => entry.package === name)?.enabled === true;

/** Rendered facts of a native switch and its mark: locked when forced, untouched otherwise. */
function lockFacts(name: string, override: Partial<LockFacts> | undefined): LockFacts {
  const locked = lockedState(name);
  const base =
    locked === undefined
      ? { hidden: false, marks: 0, lock: null, lockText: null }
      : { hidden: true, marks: 1, lock: locked, lockText: LOCK_TEXT[locked] };
  return { ...base, ...override };
}

const ABSENT: LockFacts = { hidden: null, marks: 0, lock: null, lockText: null };
// A rendered native switch without a mark: the page of a deployment that forces nothing.
const ABSENT_MARK: Partial<LockFacts> = { hidden: false, marks: 0, lock: null, lockText: null };

/** Scripted CDP page answering the evidence module's DOM expressions from released page state. */
function fakePage(options: FakeOptions, errors: unknown[]) {
  const state = {
    panel: false,
    detail: null as string | null,
    // Reads until the panel finishes loading after it opens; each change is busy for one read.
    loading: 0,
    busy: 0,
    saved: options.officeEnabled ?? true,
    shown: options.officeEnabled ?? true,
    clicks: [] as string[],
    reloads: 0,
    panelAttempts: 0,
    /** Saved native selection of the locked cards. */
    lockedSaved: false,
    /** Index into the card focus order; -1 when no catalog element has focus. */
    focus: -1,
    input: [] as string[],
    dialog: null as { phase: InstallPhase; spec: string; alert: boolean } | null,
    specFocused: false,
    installed: null as { enabled: boolean } | null,
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
    if (text.includes('role="group"')) {
      if (options.noAddGroup === true || state.dialog !== null) return false;
      state.dialog = { phase: 'idle', spec: '', alert: false };
      return true;
    }
    if (text.includes('查看 ')) {
      if (state.detail !== null) return false;
      state.detail = /查看 ([^"]+)"/.exec(text)?.[1] ?? null;
      return true;
    }
    return text.includes('role="switch"') && toggle();
  };
  const toggleState = (loaded: boolean, busy: boolean) =>
    loaded &&
    (state.detail === PACKAGE ||
      (state.detail === null && options.cards?.[PACKAGE]?.absent !== true))
      ? {
          checked: String(state.shown),
          disabled: busy || options.locked === true,
          title: options.locked === true ? '插件管理所需，不能停用或卸载' : null,
          inDetail: state.detail === PACKAGE,
          inCard: state.detail === null,
        }
      : null;
  const checkedOf = (name: string) => {
    if (name === PACKAGE) return state.shown;
    return lockedState(name) === undefined ? defaultEnabled(name) : state.lockedSaved;
  };
  // DSH renders every listed package as a card in the 已安装 group: running when selected.
  const cards = (listed: boolean) =>
    EXPECTED.map(({ package: name }) => {
      const enabled = checkedOf(name);
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
        ...(present ? lockFacts(name, options.lockFacts?.[name]) : ABSENT),
      };
    });
  const opened = (loaded: boolean) =>
    loaded && state.detail !== null
      ? {
          package: state.detail,
          switch: true,
          checked: String(checkedOf(state.detail)),
          ...lockFacts(
            state.detail,
            lockedState(state.detail) === undefined ? undefined : options.detailLock,
          ),
        }
      : null;
  // DOM order of focusable catalog elements: each card's open button, then its rendered switch.
  const focusOrder = EXPECTED.flatMap(({ package: name, locked }) => {
    const reachable =
      (locked === undefined || options.focusLocked === true) &&
      !(name === PACKAGE && options.skipRoundTripFocus === true);
    return [{ card: name, toggle: false }, ...(reachable ? [{ card: name, toggle: true }] : [])];
  });
  const focused = () => {
    const entry = focusOrder[state.focus];
    return entry === undefined
      ? { card: null, toggle: false, past: true }
      : { ...entry, past: false };
  };
  const observe = () => {
    const loaded = state.panel && state.loading === 0;
    if (state.loading > 0) state.loading -= 1;
    const busy = state.busy > 0;
    if (busy) state.busy -= 1;
    const listed = state.panel && state.detail === null;
    return {
      panel: state.panel,
      busy: state.panel ? String(!loaded) : null,
      refresh: listed && options.noRefresh !== true,
      add: listed && options.noAddButton !== true ? 1 : 0,
      uninstall: state.detail !== null && options.noUninstallButton !== true ? 1 : 0,
      cards: cards(loaded && listed),
      detail: loaded && state.detail === PACKAGE,
      opened: opened(loaded),
      toggle: toggleState(loaded, busy),
    };
  };
  const reload = (): Promise<void> => {
    state.reloads += 1;
    state.panel = false;
    state.detail = null;
    state.panelAttempts = 0;
    state.focus = -1;
    state.shown = state.saved;
    return Promise.resolve();
  };
  // Each read moves a started install one wizard phase on; the precheck may refuse instead.
  const advance = (dialog: NonNullable<typeof state.dialog>) => {
    if (dialog.phase === 'checking' && options.installRefused === true) {
      Object.assign(dialog, { phase: 'idle', alert: true });
    } else if (dialog.phase === 'checking') dialog.phase = 'starting';
    else if (dialog.phase === 'starting') dialog.phase = 'running';
    else if (dialog.phase === 'running') {
      dialog.phase = options.installFails === true ? 'failed' : 'done';
      if (dialog.phase === 'done') state.installed = { enabled: false };
      if (dialog.phase === 'done' && options.errorOnInstall === true) errors.push('installed');
    }
  };
  const enableOffered = () =>
    state.dialog?.phase === 'done' && options.installedWithoutBundle !== true;
  const observeInstall = () => {
    const dialog = state.dialog;
    if (dialog !== null) advance(dialog);
    const atSpec = dialog !== null && (dialog.phase === 'idle' || dialog.phase === 'checking');
    const enabled = state.installed?.enabled === true;
    return {
      open: dialog !== null,
      phase: dialog === null || atSpec ? null : dialog.phase,
      spec: atSpec ? dialog.spec : null,
      alert: dialog?.alert === true,
      run: dialog?.phase === 'idle' && dialog.spec !== '',
      enable: enableOffered(),
      card:
        state.installed === null
          ? null
          : {
              group: options.installedGroup ?? 'bundles',
              status: enabled ? 'running' : 'disabled',
              checked: String(enabled),
            },
    };
  };
  const clickInstall = (expression: string): boolean => {
    const dialog = state.dialog;
    if (expression.includes('"立即启用"')) {
      state.clicks.push('立即启用');
      if (!enableOffered()) return false;
      state.dialog = null;
      state.installed = { enabled: options.enableFails !== true };
      return true;
    }
    state.clicks.push('安装');
    if (dialog?.phase !== 'idle' || dialog.spec === '') return false;
    Object.assign(dialog, { phase: 'checking', alert: false });
    return true;
  };
  const evaluateInstall = (expression: string): unknown => {
    if (expression.includes('.click()')) return clickInstall(expression);
    if (!expression.includes('.focus()')) return observeInstall();
    state.specFocused = state.dialog?.phase === 'idle';
    return state.specFocused;
  };
  const evaluate = (expression: string): unknown => {
    if (expression.includes('[data-install-phase]')) return evaluateInstall(expression);
    if (expression.includes('el.click()')) return click(expression);
    if (expression.includes('first.focus()')) {
      if (!state.panel || state.detail !== null) return false;
      state.focus = 0;
      return true;
    }
    if (expression.includes('document.activeElement')) return focused();
    if (expression.includes("block:'center'"))
      return options.noMarkBox === true ? null : { x: 640, y: 360 };
    return observe();
  };
  const prepare = (): Promise<void> => {
    state.clicks.push('prepare');
    return options.prepareFails === true
      ? Promise.reject(new Error('stand-in not ready'))
      : Promise.resolve();
  };
  return {
    state,
    reload,
    prepare,
    page: {
      send(method: string, params: Record<string, unknown>) {
        if (method === 'Page.captureScreenshot')
          return Promise.resolve({ data: Buffer.from('png').toString('base64') });
        if (method === 'Input.insertText') {
          state.input.push(`text:${String(params.text)}`);
          if (state.specFocused && state.dialog?.phase === 'idle' && options.dropsInput !== true)
            state.dialog.spec += String(params.text);
          return Promise.resolve({});
        }
        if (method === 'Input.dispatchMouseEvent') {
          state.input.push(`mouse:${String(params.type)}@${String(params.x)},${String(params.y)}`);
          if (params.type === 'mouseReleased' && options.lockClickToggles === true)
            state.lockedSaved = !state.lockedSaved;
          return Promise.resolve({});
        }
        if (method === 'Input.dispatchKeyEvent') {
          state.input.push(`key:${String(params.type)}:${String(params.key)}`);
          if (params.key === 'Tab' && params.type === 'rawKeyDown') state.focus += 1;
          return Promise.resolve({});
        }
        if (method !== 'Runtime.evaluate') return Promise.reject(new Error(method));
        const expression = typeof params.expression === 'string' ? params.expression : '';
        return Promise.resolve({ result: { value: evaluate(expression) } });
      },
    },
  };
}

async function run(
  options: FakeOptions,
  ms = 3_000,
  pluginPage: Pick<PluginPageInput, 'expected' | 'roundTrip' | 'install'> = {
    expected: EXPECTED,
    roundTrip: { package: PACKAGE, leaveEnabled: true },
  },
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-plugin-page-'));
  roots.push(root);
  const errors: unknown[] = [];
  const { page, state, reload, prepare } = fakePage(options, errors);
  const { install } = pluginPage;
  const result = verifyPluginPage({
    page,
    errors,
    screenshot: join(root, 'entry.png'),
    ms,
    reload,
    ...pluginPage,
    ...(install === undefined ? {} : { install: { prepare, ...install } }),
  });
  return { result, state, root };
}

const shots = (root: string, ...names: string[]) =>
  names.map((name) => ({ screenshot: join(root, `entry-plugin-page-${name}.png`), bytes: 3 }));
const cardsWith = (office: { status: string; checked: boolean }) =>
  EXPECTED.map(({ package: name, enabled, locked }) => {
    if (name === PACKAGE) return { package: name, ...office, locked: null };
    if (locked !== undefined) return { package: name, status: 'disabled', checked: false, locked };
    return {
      package: name,
      status: enabled ? 'running' : 'disabled',
      checked: enabled,
      locked: null,
    };
  });
// Every catalog card reached by Tab in order; the locked switches are skipped.
const LOCKED_EVIDENCE = {
  package: TIERS,
  focus: {
    presses: 7,
    visited: EXPECTED.map((entry) => entry.package),
    roundTripSwitch: true,
  },
  input: { checked: false, lock: 'forced-on' },
  detail: { lock: 'forced-on', uninstallButtons: 1 },
};
const LOCK_INPUT = [
  ...Array.from({ length: 7 }, () => ['key:rawKeyDown:Tab', 'key:keyUp:Tab']).flat(),
  'mouse:mouseMoved@640,360',
  'mouse:mousePressed@640,360',
  'mouse:mouseReleased@640,360',
  'key:keyDown:Enter',
  'key:keyUp:Enter',
  'key:keyDown: ',
  'key:keyUp: ',
];

it('accepts a page with install entries whose switch round-trips across reloads', async () => {
  const { result, state, root } = await run({});

  const evidence = await result;

  expect(evidence).toEqual({
    list: { refresh: true, addButtons: 1, group: 'bundles', status: 'running', checked: true },
    detail: { uninstallButtons: 1, checked: true, disabled: false, title: null },
    off: { checked: false, status: 'disabled' },
    on: { checked: true, status: 'running' },
    cards: cardsWith({ status: 'running', checked: true }),
    locked: LOCKED_EVIDENCE,
    screenshots: shots(root, 'list', 'locked', 'locked-detail', 'detail', 'off', 'on'),
  });
  expect(state.clicks).toEqual([
    PANEL,
    PANEL,
    OPEN_TIERS,
    PANEL,
    OPEN,
    SWITCH,
    PANEL,
    SWITCH,
    PANEL,
  ]);
  expect(state.input).toEqual(LOCK_INPUT);
  expect(state.lockedSaved).toBe(false);
  expect(state.reloads).toBe(4);
  expect((await readdir(root)).sort()).toEqual([
    'entry-plugin-page-detail.png',
    'entry-plugin-page-list.png',
    'entry-plugin-page-locked-detail.png',
    'entry-plugin-page-locked.png',
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
    locked: LOCKED_EVIDENCE,
    screenshots: shots(root, 'list', 'locked', 'locked-detail', 'detail', 'off'),
  });
  expect(state.clicks).toEqual([PANEL, PANEL, OPEN_TIERS, PANEL, OPEN, SWITCH, PANEL]);
  expect(state.saved).toBe(false);
});

it('starts from a disabled bundle when the catalog state says so, and switches it back on', async () => {
  const expected = EXPECTED.map((entry) =>
    entry.package === PACKAGE ? { ...entry, enabled: false } : entry,
  );
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
    locked: LOCKED_EVIDENCE,
    screenshots: shots(root, 'list', 'locked', 'locked-detail', 'detail', 'on'),
  });
  expect(state.clicks).toEqual([PANEL, PANEL, OPEN_TIERS, PANEL, OPEN, SWITCH, PANEL]);
  expect(state.saved).toBe(true);
});

const UNLOCKED = EXPECTED.map(({ package: name, enabled }) => ({ package: name, enabled }));
const UNLOCKED_PAGE: Partial<FakeOptions> = {
  lockFacts: Object.fromEntries(
    EXPECTED.filter((entry) => entry.locked).map(({ package: name }) => [name, ABSENT_MARK]),
  ),
};

it('runs no lock steps when no package is expected locked', async () => {
  const { result, state, root } = await run(UNLOCKED_PAGE, 3_000, {
    expected: UNLOCKED,
    roundTrip: { package: PACKAGE, leaveEnabled: true },
  });

  const evidence = await result;

  expect(evidence.locked).toBeUndefined();
  expect(evidence.screenshots).toEqual(shots(root, 'list', 'detail', 'off', 'on'));
  expect(state.clicks).toEqual([PANEL, OPEN, SWITCH, PANEL, SWITCH, PANEL]);
  expect(state.input).toEqual([]);
});

it('rejects a round-trip detail without 卸载 when nothing is locked', async () => {
  const { result } = await run({ ...UNLOCKED_PAGE, noUninstallButton: true }, 600, {
    expected: UNLOCKED,
    roundTrip: { package: PACKAGE, leaveEnabled: true },
  });

  await expect(result).rejects.toThrow(/stage=plugin-page-detail error=uninstall/);
});

// Five page loads (the first and four reloads), each answering the panel click only on attempt 3.
it('waits for a sidebar panel row that renders after the app is ready', async () => {
  const { result, state } = await run({ latePanel: 2 });

  await expect(result).resolves.toMatchObject({ on: { checked: true, status: 'running' } });
  expect(state.clicks.filter((click) => click === PANEL)).toHaveLength(15);
}, 15_000);

it.each<[string, FakeOptions, RegExp]>([
  ['a list without 添加插件', { noAddButton: true }, /stage=plugin-page-list error=add-plugin/],
  [
    'a locked detail without 卸载',
    { noUninstallButton: true },
    /stage=plugin-page-locked-detail error=uninstall/,
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
    'a default-enabled manageable card shown disabled',
    { cards: { [KNOWLEDGE]: { status: 'disabled', checked: false } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'the office bundle shown disabled',
    { officeEnabled: false },
    /stage=plugin-page-list error=catalog-card/,
  ],
  ['a locked switch', { locked: true }, /stage=plugin-page-list/],
  [
    'a forced card whose native switch still renders',
    { lockFacts: { [TIERS]: { hidden: false } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'a forced card without its mark',
    { lockFacts: { [TIERS]: { marks: 0, lock: null, lockText: null } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'a forced card with two marks',
    { lockFacts: { [TIERS]: { marks: 2, lock: null, lockText: null } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'a forced-on card marked off',
    { lockFacts: { [TIERS]: { lock: 'forced-off', lockText: LOCK_TEXT['forced-off'] } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'a mark without the administrator text',
    { lockFacts: { [TIERS]: { lockText: '已开启' } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'an ordinary card with a mark',
    { lockFacts: { [PACKAGE]: { marks: 1 } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'an ordinary card whose switch is hidden',
    { lockFacts: { [PACKAGE]: { hidden: true } } },
    /stage=plugin-page-list error=catalog-card/,
  ],
  [
    'a forced switch reachable by Tab',
    { focusLocked: true },
    /stage=plugin-page-focus error=locked-switch/,
  ],
  [
    'a traversal that never reaches a switch',
    { skipRoundTripFocus: true },
    /stage=plugin-page-focus error=traversal/,
  ],
  [
    'a forced card that a pointer click switches',
    { lockClickToggles: true },
    /stage=plugin-page-locked error=catalog-card/,
  ],
  ['a mark without a box', { noMarkBox: true }, /stage=plugin-page-locked-input error=mark-box/],
  [
    'a forced detail whose native switch still renders',
    { detailLock: { hidden: false } },
    /stage=plugin-page-locked-detail error=lock/,
  ],
  [
    'a forced detail without its mark',
    { detailLock: { marks: 0, lock: null, lockText: null } },
    /stage=plugin-page-locked-detail error=timeout/,
  ],
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
  [
    'a round trip on a locked package',
    { expected: EXPECTED, roundTrip: { package: TIERS, leaveEnabled: true } },
  ],
  [
    'an unknown lock state',
    {
      expected: EXPECTED.map((entry) => (entry.locked ? { ...entry, locked: 'employee' } : entry)),
      roundTrip: { package: PACKAGE, leaveEnabled: true },
    },
  ],
])('rejects options with %s before touching the page', async (_name, pluginPage) => {
  const { result, state } = await run({}, 600, pluginPage as never);

  await expect(result).rejects.toThrow(/^stage=plugin-page error=options$/);
  expect(state.clicks).toEqual([]);
});

const ADD_PRIMARY = 'span[role="group"][aria-label="添加插件"] > button';
const INSTALL = { package: PROBE_PLUGIN };
const ROUND_TRIP = { package: PACKAGE, leaveEnabled: true };
const INSTALLED = {
  package: PROBE_PLUGIN,
  card: { group: 'bundles', status: 'running', checked: true },
};
// The fixture's stand-in runs first, then 添加插件, the spec, 安装 and, once installed, 立即启用.
const INSTALL_CLICKS = ['prepare', ADD_PRIMARY, '安装', '立即启用'];

it('installs a package through the dialog after the round trip and enables it', async () => {
  const { result, state, root } = await run({}, 3_000, {
    expected: EXPECTED,
    roundTrip: ROUND_TRIP,
    install: INSTALL,
  });

  const evidence = await result;

  expect(evidence).toMatchObject({
    on: { checked: true, status: 'running' },
    cards: cardsWith({ status: 'running', checked: true }),
    install: INSTALLED,
  });
  expect(evidence.screenshots).toEqual(
    shots(
      root,
      'list',
      'locked',
      'locked-detail',
      'detail',
      'off',
      'on',
      'install-done',
      'installed',
    ),
  );
  expect(state.clicks.slice(-INSTALL_CLICKS.length)).toEqual(INSTALL_CLICKS);
  expect(state.input).toEqual([...LOCK_INPUT, `text:${PROBE_PLUGIN}`]);
});

it('runs the preparation before the dialog and stops at its rejection', async () => {
  const { result, state } = await run({ prepareFails: true }, 600, {
    expected: EXPECTED,
    roundTrip: ROUND_TRIP,
    install: INSTALL,
  });

  await expect(result).rejects.toThrow('stand-in not ready');
  expect(state.clicks.slice(-1)).toEqual(['prepare']);
  expect(state.dialog).toBeNull();
});

it.each<[string, FakeOptions, RegExp]>([
  [
    'a header without the 添加插件 group',
    { noAddGroup: true },
    /stage=plugin-install-open error=add observed=null/,
  ],
  [
    'a spec input that drops the text',
    { dropsInput: true },
    /stage=plugin-install-spec error=timeout/,
  ],
  [
    'a refused precheck',
    { installRefused: true },
    /stage=plugin-install-check error=refused observed=.*"alert":true/,
  ],
  ['a failed install', { installFails: true }, /stage=plugin-install-run error=failed/],
  [
    'an install without 立即启用',
    { installedWithoutBundle: true },
    /stage=plugin-install-done error=enable-now/,
  ],
  ['a card that never runs', { enableFails: true }, /stage=plugin-install-enabled error=timeout/],
  [
    'a card outside the 已安装 group',
    { installedGroup: 'official' },
    /stage=plugin-install-enabled error=card/,
  ],
  ['a console error while installing', { errorOnInstall: true }, /error=console count=1/],
])('rejects an install with %s', async (_name, options, failure) => {
  const { result } = await run(options, 600, {
    expected: EXPECTED,
    roundTrip: ROUND_TRIP,
    install: INSTALL,
  });

  await expect(result).rejects.toThrow(failure);
});

it.each<[string, Record<string, unknown>]>([
  ['a catalog package', { package: PACKAGE }],
  ['no package', {}],
  ['an empty package', { package: '' }],
  ['a preparation that is not a function', { package: PROBE_PLUGIN, prepare: 'start' }],
])('rejects install options with %s before touching the page', async (_name, install) => {
  const pluginPage = { expected: EXPECTED, roundTrip: ROUND_TRIP, install };
  const { result, state } = await run({}, 600, pluginPage as never);

  await expect(result).rejects.toThrow(/^stage=plugin-page error=options$/);
  expect(state.clicks).toEqual([]);
});
