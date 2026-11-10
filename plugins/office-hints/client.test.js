import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create } from 'react-test-renderer';

let registration;
globalThis.window = { __ModuleLoader__: { load: (value) => (registration = value) } };
await import('./client.js');
Reflect.deleteProperty(globalThis, 'window');

const EXTS = ['docx', 'xlsx', 'pptx'];
const COLLAB = '请勿在 AI 修改此文件时同时编辑；人工修改保存完成后，再让 AI 继续处理。';
const NO_SESSION = '请先新建或进入一个会话（Session），再打开 Office 文件。';
const UNAVAILABLE = 'Office 编辑器未加载，请关闭后重新打开此文件。';
const HINT = 'data-dsh-team-office-hint';

/**
 * The released better-sidebar 0.28.0 registry semantics (src/client/service.ts:889-937, :1052,
 * :1337): registration stores, notifies every listener synchronously without catching, and only
 * then returns the disposer; a duplicate id throws; an absent `viewersEnabled` key is enabled.
 */
function betterSidebar() {
  const viewers = new Map();
  const listeners = new Set();
  const stateListeners = new Set();
  const viewersEnabled = {};
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const service = {
    registerFileViewer: vi.fn((descriptor) => {
      if (viewers.has(descriptor.id)) {
        throw new Error(`[dsh-better-sidebar] file viewer "${descriptor.id}" already registered`);
      }
      viewers.set(descriptor.id, descriptor);
      notify();
      return () => {
        if (viewers.get(descriptor.id) === descriptor) {
          viewers.delete(descriptor.id);
          notify();
        }
      };
    }),
    getFileViewers: () => Array.from(viewers.values()),
    isViewerEnabled: (id) => viewersEnabled[id] !== false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
  return {
    service,
    listeners,
    stateListeners,
    notify,
    setEnabled(id, enabled) {
      viewersEnabled[id] = enabled;
      for (const listener of [...stateListeners]) listener();
    },
    ids: () => [...viewers.keys()].sort(),
    viewer: (id) => viewers.get(id),
    wrapperRegistrations: () =>
      service.registerFileViewer.mock.calls.filter(([{ id }]) => id.startsWith('office-hints:'))
        .length,
  };
}

const onlyofficeRenders = [];
/** Stands in for OnlyOfficeView: it owns hooks, as the released view does (:106-121). */
function OnlyOfficeView(props) {
  const [mounted] = React.useState('onlyoffice-mounted');
  onlyofficeRenders.push(props);
  return React.createElement('div', { 'data-fake-onlyoffice': props.path }, mounted);
}
const onlyoffice = (ext) => ({
  id: `onlyoffice:${ext}`,
  exts: [ext],
  priority: 10,
  fetchStrategy: 'none',
  component: OnlyOfficeView,
});

/** One client plugin apply on a fresh registry, with cordis-style effects owned by the test. */
function applyPlugin(sidebar = betterSidebar()) {
  const required = [];
  const plugin = registration.factory((id) => {
    required.push(id);
    return React;
  });
  const effects = [];
  plugin.apply({
    betterSidebar: sidebar.service,
    effect: (execute) => {
      effects.push(execute());
    },
  });
  const unload = () => {
    for (const dispose of effects.splice(0).reverse()) dispose();
  };
  applied.push(unload);
  return { sidebar, plugin, required, effects, unload };
}

const applied = [];
const mounted = [];
let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  for (const view of mounted.splice(0)) act(() => view.unmount());
  for (const unload of applied.splice(0)) unload();
  onlyofficeRenders.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(component, props) {
  let view;
  act(() => {
    view = create(React.createElement(component, props));
  });
  mounted.push(view);
  return view;
}

const text = (view) =>
  view.root
    .findAll((node) => typeof node.children?.[0] === 'string')
    .map((node) => node.children.join(''));
const hints = (view) => view.root.findAll((node) => node.props[HINT] !== undefined);
const props = (sessionId) => ({
  ctx: {},
  store: {},
  scope: sessionId === undefined ? {} : { sessionId, cwd: '/data/work' },
  path: '/data/work/报告.docx',
  title: '报告.docx',
  viewerId: 'office-hints:docx',
});

it('loads as a classic script that injects only betterSidebar and takes React from the DSH seed', () => {
  const { plugin, required } = applyPlugin();

  expect(registration.id).toBe('@dsh-team/office-hints');
  expect(plugin.inject).toEqual(['betterSidebar']);
  expect(required).toEqual(['react']);
});

it('registers no wrapper while no ONLYOFFICE viewer is registered', () => {
  const sidebar = betterSidebar();
  sidebar.service.registerFileViewer({ id: 'docx', exts: ['docx'], fetchStrategy: 'none' });

  applyPlugin(sidebar);
  sidebar.notify();
  sidebar.setEnabled('docx', true);

  expect(sidebar.ids()).toEqual(['docx']);
  expect(sidebar.wrapperRegistrations()).toBe(0);
});

it('registers only office-hints:docx once an enabled onlyoffice:docx is registered', () => {
  const { sidebar } = applyPlugin();

  expect(() => sidebar.service.registerFileViewer(onlyoffice('docx'))).not.toThrow();

  expect(sidebar.ids()).toEqual(['office-hints:docx', 'onlyoffice:docx']);
  const { component, ...descriptor } = sidebar.viewer('office-hints:docx');
  expect(descriptor).toEqual({
    id: 'office-hints:docx',
    title: 'Office 提示（docx）',
    exts: ['docx'],
    priority: 20,
    fetchStrategy: 'none',
  });
  expect(typeof component).toBe('function');
});

it('wraps every ONLYOFFICE viewer already registered and enabled when it applies', () => {
  const sidebar = betterSidebar();
  for (const ext of EXTS) sidebar.service.registerFileViewer(onlyoffice(ext));

  applyPlugin(sidebar);

  expect(sidebar.ids()).toEqual([
    'office-hints:docx',
    'office-hints:pptx',
    'office-hints:xlsx',
    'onlyoffice:docx',
    'onlyoffice:pptx',
    'onlyoffice:xlsx',
  ]);
  expect(
    EXTS.map((ext) => [
      sidebar.viewer(`office-hints:${ext}`).title,
      ...sidebar.viewer(`office-hints:${ext}`).exts,
    ]),
  ).toEqual([
    ['Office 提示（docx）', 'docx'],
    ['Office 提示（xlsx）', 'xlsx'],
    ['Office 提示（pptx）', 'pptx'],
  ]);
});

it('follows the ONLYOFFICE viewer enable switch through preference notifications', () => {
  const sidebar = betterSidebar();
  sidebar.setEnabled('onlyoffice:docx', false);
  sidebar.service.registerFileViewer(onlyoffice('docx'));
  applyPlugin(sidebar);
  const absent = sidebar.ids();

  sidebar.setEnabled('onlyoffice:docx', true);
  const enabled = sidebar.ids();
  sidebar.setEnabled('onlyoffice:docx', false);
  const disabled = sidebar.ids();
  sidebar.setEnabled('onlyoffice:docx', true);

  expect(absent).toEqual(['onlyoffice:docx']);
  expect(enabled).toEqual(['office-hints:docx', 'onlyoffice:docx']);
  expect(disabled).toEqual(['onlyoffice:docx']);
  expect(sidebar.ids()).toEqual(['office-hints:docx', 'onlyoffice:docx']);
  expect(sidebar.wrapperRegistrations()).toBe(2);
});

it('withdraws the wrapper when ONLYOFFICE disposes its viewer and never wraps an extension it did not register', () => {
  const { sidebar } = applyPlugin();
  const dispose = sidebar.service.registerFileViewer(onlyoffice('docx'));

  expect(() => dispose()).not.toThrow();
  sidebar.setEnabled('onlyoffice:xlsx', true);
  sidebar.notify();

  expect(sidebar.ids()).toEqual([]);
  expect(sidebar.wrapperRegistrations()).toBe(1);
});

it('registers each wrapper once across repeated and re-entrant notifications without throwing', () => {
  const sidebar = betterSidebar();
  // Another subscriber that re-notifies from inside every notification, as nested registrations do.
  let depth = 0;
  sidebar.service.subscribe(() => {
    if (depth++ < 3) sidebar.notify();
    depth--;
  });
  applyPlugin(sidebar);

  for (const ext of EXTS)
    expect(() => sidebar.service.registerFileViewer(onlyoffice(ext))).not.toThrow();
  for (let round = 0; round < 3; round += 1) {
    sidebar.notify();
    sidebar.setEnabled('unrelated', true);
  }

  expect(sidebar.wrapperRegistrations()).toBe(3);
  expect(sidebar.ids().filter((id) => id.startsWith('office-hints:'))).toEqual([
    'office-hints:docx',
    'office-hints:pptx',
    'office-hints:xlsx',
  ]);
});

it('never lets a failing registry read escape a listener, and recovers on the next notification', () => {
  const sidebar = betterSidebar();
  const enabled = sidebar.service.isViewerEnabled;
  sidebar.service.isViewerEnabled = vi.fn(() => {
    throw new Error('prefs unavailable');
  });
  sidebar.service.registerFileViewer(onlyoffice('docx'));
  applyPlugin(sidebar);

  expect(() => sidebar.notify()).not.toThrow();
  expect(() => sidebar.setEnabled('onlyoffice:docx', true)).not.toThrow();
  const failed = sidebar.ids();
  sidebar.service.isViewerEnabled = enabled;
  sidebar.notify();

  expect(failed).toEqual(['onlyoffice:docx']);
  expect(sidebar.ids()).toEqual(['office-hints:docx', 'onlyoffice:docx']);
});

it.each([
  ['an empty Session id', ''],
  ['a missing Session id', undefined],
])('shows only the no-session hint for %s and never renders ONLYOFFICE', (_name, sessionId) => {
  const { sidebar } = applyPlugin();
  sidebar.service.registerFileViewer(onlyoffice('docx'));

  const view = render(sidebar.viewer('office-hints:docx').component, props(sessionId));

  expect(hints(view).map((node) => node.props[HINT])).toEqual(['no-session']);
  expect(text(view)).toEqual([NO_SESSION]);
  expect(view.root.findAllByType(OnlyOfficeView)).toEqual([]);
  expect(onlyofficeRenders).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('puts the collaboration hint above the ONLYOFFICE editor element rendered with the same props', () => {
  const { sidebar } = applyPlugin();
  sidebar.service.registerFileViewer(onlyoffice('docx'));
  const input = props('session-1');

  const view = render(sidebar.viewer('office-hints:docx').component, input);

  expect(hints(view).map((node) => node.props[HINT])).toEqual(['collab']);
  expect(text(view)).toEqual([COLLAB, 'onlyoffice-mounted']);
  const editor = view.root.findByType(OnlyOfficeView);
  expect(editor.props).toEqual(input);
  expect(onlyofficeRenders).toEqual([input]);
  const frame = view.root.findByProps({ 'data-dsh-team-office-hints': 'docx' });
  expect(frame.props.style).toMatchObject({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  });
  expect(editor.parent.props.style).toMatchObject({ flex: '1 1 0', minHeight: 0 });
});

it('can be called directly as a render function, as better-sidebar does outside the editor host', () => {
  const { sidebar } = applyPlugin();
  sidebar.service.registerFileViewer(onlyoffice('docx'));
  const { component } = sidebar.viewer('office-hints:docx');

  const element = component(props('session-1'));

  expect(React.isValidElement(element)).toBe(true);
  expect(onlyofficeRenders).toEqual([]);
});

it.each([
  ['disposed', (sidebar, dispose) => dispose()],
  ['disabled', (sidebar) => sidebar.setEnabled('onlyoffice:docx', false)],
])(
  're-renders a mounted editor into the not-loaded notice once ONLYOFFICE is %s',
  (_name, change) => {
    const { sidebar } = applyPlugin();
    const dispose = sidebar.service.registerFileViewer(onlyoffice('docx'));
    const { component } = sidebar.viewer('office-hints:docx');
    const input = props('session-1');
    const view = render(component, input);

    change(sidebar, dispose);
    expect(() => act(() => view.update(React.createElement(component, input)))).not.toThrow();

    expect(text(view)).toEqual([UNAVAILABLE]);
    expect(hints(view)).toEqual([]);
    expect(view.root.findAllByType(OnlyOfficeView)).toEqual([]);
  },
);

it('re-renders a mounted not-loaded notice into the editor once ONLYOFFICE is enabled again', () => {
  const { sidebar } = applyPlugin();
  sidebar.service.registerFileViewer(onlyoffice('docx'));
  const { component } = sidebar.viewer('office-hints:docx');
  const input = props('session-1');
  sidebar.setEnabled('onlyoffice:docx', false);
  const view = render(component, input);
  const before = text(view);

  sidebar.setEnabled('onlyoffice:docx', true);
  expect(() => act(() => view.update(React.createElement(component, input)))).not.toThrow();

  expect(before).toEqual([UNAVAILABLE]);
  expect(text(view)).toEqual([COLLAB, 'onlyoffice-mounted']);
  expect(view.root.findByType(OnlyOfficeView).props).toEqual(input);
});

it('withdraws every wrapper and subscription when the plugin unloads', () => {
  const { sidebar, unload } = applyPlugin();
  for (const ext of EXTS) sidebar.service.registerFileViewer(onlyoffice(ext));
  const before = sidebar.ids().length;

  unload();
  sidebar.notify();
  sidebar.setEnabled('onlyoffice:docx', true);

  expect(before).toBe(6);
  expect(sidebar.ids()).toEqual(['onlyoffice:docx', 'onlyoffice:pptx', 'onlyoffice:xlsx']);
  expect(sidebar.listeners.size).toBe(0);
  expect(sidebar.stateListeners.size).toBe(0);
  expect(sidebar.wrapperRegistrations()).toBe(3);
});
