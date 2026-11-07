// @vitest-environment jsdom
/* global document, window, getComputedStyle, Document, Element */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create } from 'react-test-renderer';

let registration;
window.__ModuleLoader__ = { load: (value) => (registration = value) };
await import('./client.js');
Reflect.deleteProperty(window, '__ModuleLoader__');

const GLOBAL = '__DSH_TEAM_PLATFORM_NAV__';
const required = [];
const plugin = registration.factory((id) => {
  required.push(id);
  return React;
});
const injected = [];
const registered = [];
// The registration apply also installs the page's locks; its observer is retired before any test.
const bootObservers = [];
const BootObserver = globalThis.MutationObserver;
globalThis.MutationObserver = class extends BootObserver {
  constructor(callback) {
    super(callback);
    bootObservers.push(this);
  }
};
plugin.apply({
  slots: {
    inject: (name, install) => {
      injected.push(name);
      install();
    },
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    },
  },
});
const Entry = registered[0]?.component;
globalThis.MutationObserver = BootObserver;
for (const observer of bootObservers) observer.disconnect();
const bootStyles = [...document.head.querySelectorAll('style')].map((style) =>
  style.getAttribute('data-dsh-team-plugin-lock'),
);
document.head.replaceChildren();

let fetchSpy;
let consoleSpies;
const NativeObserver = globalThis.MutationObserver;
const observers = [];
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
    vi.spyOn(console, method),
  );
  // Records every observer the client creates so each test can count and retire them.
  vi.stubGlobal(
    'MutationObserver',
    class extends NativeObserver {
      constructor(callback) {
        super(callback);
        observers.push(this);
      }
    },
  );
});
const mounted = [];
afterEach(() => {
  for (const view of mounted.splice(0)) act(() => view.unmount());
  for (const observer of observers.splice(0)) observer.disconnect();
  document.head.replaceChildren();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, GLOBAL);
});

function render(wide, value, present = true) {
  if (present) globalThis[GLOBAL] = value;
  let view;
  act(() => {
    view = create(React.createElement(Entry, { wide }));
  });
  const root = view.root.findByProps({ 'data-dsh-team-platform-nav': wide ? 'wide' : 'rail' });
  const links = root.findAllByType('a').map((link) => ({
    href: link.props.href,
    label: link.props['aria-label'],
    text: link
      .findAll((node) => typeof node.children?.[0] === 'string' && node.type === 'span')
      .map((node) => node.children[0])
      .join(''),
    target: link.props.target,
  }));
  mounted.push(view);
  return { root, links };
}

it('registers exactly one sidebar footer list entry through React from the DSH seed', () => {
  expect(registration.id).toBe('@dsh-team/platform-nav');
  expect(plugin.inject).toEqual(['slots']);
  expect(required).toEqual(['react']);
  expect(injected).toEqual(['sidebar.footer.action']);
  expect(registered.map(({ options }) => options)).toEqual([
    { name: 'sidebar.footer.action', id: 'dsh-team-platform-nav', order: 1 },
  ]);
  // Without any page global the same apply still installs the sandbox lock, and only it.
  expect(bootObservers).toHaveLength(1);
  expect(bootStyles).toEqual(['html-sandbox']);
});

const ACCOUNT_WIDE = {
  href: '/_platform/account',
  label: undefined,
  text: '账号设置',
  target: undefined,
};
const ADMIN_WIDE = {
  href: '/_platform/admin',
  label: undefined,
  text: '管理后台',
  target: undefined,
};
const ACCOUNT_RAIL = { href: '/_platform/account', label: '账号设置', text: '', target: undefined };
const ADMIN_RAIL = { href: '/_platform/admin', label: '管理后台', text: '', target: undefined };

it.each([
  [
    'an administrator',
    { admin: true },
    true,
    [ACCOUNT_WIDE, ADMIN_WIDE],
    [ACCOUNT_RAIL, ADMIN_RAIL],
  ],
  ['an employee', { admin: false }, true, [ACCOUNT_WIDE], [ACCOUNT_RAIL]],
  ['a missing global', undefined, false, [ACCOUNT_WIDE], [ACCOUNT_RAIL]],
  ['a null global', null, true, [ACCOUNT_WIDE], [ACCOUNT_RAIL]],
  ['a boolean global', true, true, [ACCOUNT_WIDE], [ACCOUNT_RAIL]],
  ['a string flag', { admin: 'true' }, true, [ACCOUNT_WIDE], [ACCOUNT_RAIL]],
  ['an array global', [true], true, [ACCOUNT_WIDE], [ACCOUNT_RAIL]],
])(
  'renders same-tab platform links for %s without network or console use',
  (_name, value, present, wide, rail) => {
    expect(render(true, value, present).links).toEqual(wide);
    expect(render(false, value, present).links).toEqual(rail);

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  },
);

it('keeps compact rail links square with inline icons and native colour variables', () => {
  const { root } = render(false, { admin: true });
  const links = root.findAllByType('a');

  for (const link of links) {
    expect(link.props.title).toBe(link.props['aria-label']);
    expect(link.props.style).toMatchObject({
      width: '36px',
      height: '36px',
      color: 'var(--dsw-alias-label-primary)',
    });
    expect(link.findByType('svg').props['aria-hidden']).toBe(true);
  }
  expect(root.props.style).toMatchObject({ width: '36px' });
});

it('renders wide text rows with the sidebar row metrics and one scoped style element', () => {
  const { root } = render(true, { admin: false });
  const [link] = root.findAllByType('a');
  const style = root.findByType('style');

  expect(root.type).toBe('nav');
  expect(root.props['aria-label']).toBe('平台入口');
  expect(root.props.style).toMatchObject({ width: '100%' });
  expect(link.props.style).toMatchObject({
    height: '36px',
    borderRadius: 'var(--dsw-radius-md)',
    color: 'var(--dsw-alias-label-primary)',
    textDecoration: 'none',
  });
  expect(link.findByType('svg').props.width).toBe(16);
  expect(style.props.children).toContain(
    ':has(> [data-slot="sidebar.footer.action"] > [data-dsh-team-platform-nav])' +
      '{flex-direction:column;align-items:center}',
  );
  expect(style.props.children).toContain('var(--dsw-alias-interactive-bg-hover)');
  expect(style.props.children).not.toMatch(/url\(|@import|https?:/);
});

// Lock display fixtures: the released 0.2.1-rc.2 plugin page shapes, as jsdom DOM.
const OFFICE = '@dsh-team/office-agents';
const LOCALE = '@dsh-team/zh-locale';
const EMPLOYEE = '@dsh-team/permission-tiers';
const FOREIGN = '@deepseek-ai/dsh-base';
const ON = '已开启 · 由管理员设定';
const OFF = '已关闭 · 由管理员设定';
const LOCKS = { [LOCALE]: 'forced-on', [OFFICE]: 'forced-off' };
const LOCK = 'data-dsh-team-plugin-lock';
const CATALOG_STYLE = `style[${LOCK}=""]`;
const SANDBOX_STYLE = `style[${LOCK}="html-sandbox"]`;

/** Run the client's apply as DSH does once per page, with the page global as given. */
function install(value, present = true) {
  if (present) globalThis[GLOBAL] = value;
  registration
    .factory(() => React)
    .apply({ slots: { inject: () => {}, register: () => () => {} } });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fromHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

/** The released `PackageCard` shape: head with artwork, open button, and the end switch. */
function card(name, checked) {
  return fromHtml(`
    <li class="card cardLink" data-plugin-package="${name}" data-plugin-status="${checked ? 'running' : 'disabled'}">
      <div class="cardHead">
        <span class="cardIcon" aria-hidden="true"></span>
        <div class="cardMain">
          <div class="titleRow"><button type="button" class="cardOpen" aria-label="查看 ${name}">${name}</button></div>
          <span class="cardDesc">desc</span>
        </div>
        <div class="cardEnd"><button type="button" role="switch" aria-checked="${checked}" aria-label="启用 ${name}"></button></div>
      </div>
    </li>`);
}

/** The released list: header with 「添加插件」 and the installed bundle group. */
function list() {
  const root = fromHtml(`
    <section data-plugin-panel aria-busy="false">
      <header><button type="button" aria-label="刷新"></button><button type="button">添加插件</button></header>
      <section data-plugin-group="bundles"><ul class="cards"></ul></section>
    </section>`);
  root
    .querySelector('ul')
    .append(card(OFFICE, false), card(LOCALE, false), card(EMPLOYEE, true), card(FOREIGN, true));
  return root;
}

/** The released detail page: `DetailTop` (crumb, head with actions ending in the switch), then rows. */
function detail(name) {
  return fromHtml(`
    <div class="detail" data-plugin-detail="${name}">
      <div class="detailTop" data-window-drag>
        <button type="button" class="crumb" aria-label="返回列表"><span>插件</span></button>
        <div class="detailHead">
          <span class="cardIcon" aria-hidden="true"></span>
          <div class="detailActions">
            <div data-slot="plugins.detail.actions"></div>
            <button type="button" aria-label="更新 ${name}">更新</button>
            <button type="button" aria-label="卸载 ${name}">卸载</button>
            <button type="button" role="switch" aria-checked="false" aria-label="启用 ${name}"></button>
          </div>
        </div>
      </div>
      <div class="detailMain">
        <div class="rows"><button type="button" role="switch" aria-checked="true" aria-label="row"></button></div>
      </div>
    </div>`);
}

const marks = (root) => [...root.querySelectorAll(`[${LOCK}]`)];
const cardSwitch = (name) =>
  document.querySelector(`[data-plugin-package="${name}"] button[role="switch"]`);
const topSwitch = (name) =>
  document.querySelector(`[data-plugin-detail="${name}"] .detailActions > button[role="switch"]`);
const shown = (element) => getComputedStyle(element).display !== 'none';
const lockAfter = (element) => {
  const next = element.nextElementSibling;
  return next?.hasAttribute(LOCK)
    ? { tag: next.tagName, state: next.getAttribute(LOCK), text: next.textContent }
    : null;
};

/** Locked forced cards and the forced detail switch; everything else exactly as DSH rendered it. */
function expectDecorated() {
  expect(lockAfter(cardSwitch(LOCALE))).toEqual({ tag: 'SPAN', state: 'forced-on', text: ON });
  expect(lockAfter(cardSwitch(OFFICE))).toEqual({ tag: 'SPAN', state: 'forced-off', text: OFF });
  expect(lockAfter(topSwitch(LOCALE))).toEqual({ tag: 'SPAN', state: 'forced-on', text: ON });
  for (const element of [cardSwitch(LOCALE), cardSwitch(OFFICE), topSwitch(LOCALE)])
    expect(shown(element)).toBe(false);
  for (const name of [EMPLOYEE, FOREIGN]) {
    expect(shown(cardSwitch(name))).toBe(true);
    expect(lockAfter(cardSwitch(name))).toBeNull();
  }
  expect(marks(document.body)).toHaveLength(3);
  const untouched = [
    ...document.querySelectorAll('button:not([role="switch"])'),
    document.querySelector('[aria-label="row"]'),
  ];
  for (const element of untouched) expect(shown(element)).toBe(true);
  expect([...document.querySelectorAll('button')].map((el) => el.textContent)).toContain(
    '添加插件',
  );
}

/** DSH's own markup with the inserted marks removed. */
function dshMarkup() {
  const copy = document.body.cloneNode(true);
  for (const mark of marks(copy)) mark.remove();
  return copy.innerHTML;
}

describe('forced plugin lock display', () => {
  it.each([
    ['a missing global', undefined, false],
    ['a null global', null, true],
    ['an admin-only global', { admin: true }, true],
    ['an empty state map', { admin: false, pluginCatalog: {} }, true],
    ['a null state map', { admin: false, pluginCatalog: null }, true],
    ['an array state map', { admin: false, pluginCatalog: [LOCALE] }, true],
    ['an employee state', { admin: false, pluginCatalog: { [LOCALE]: 'employee' } }, true],
    ['an unknown state', { admin: false, pluginCatalog: { [LOCALE]: 'on' } }, true],
    [
      'a selector-breaking name beside a valid one',
      { admin: false, pluginCatalog: { [LOCALE]: 'forced-on', 'x"] *': 'forced-off' } },
      true,
    ],
  ])(
    'adds no catalog rule or mark for %s, only the sandbox lock',
    async (_name, value, present) => {
      document.body.append(list(), detail(LOCALE));
      const before = document.body.innerHTML;

      install(value, present);
      document.body.append(card(LOCALE, false));
      await flush();

      expect(document.head.querySelectorAll(CATALOG_STYLE)).toHaveLength(0);
      expect(document.head.querySelectorAll(SANDBOX_STYLE)).toHaveLength(1);
      expect(observers).toHaveLength(1);
      expect(marks(document.body)).toEqual([]);
      expect(document.body.innerHTML).toBe(before + card(LOCALE, false).outerHTML);
    },
  );

  it('injects exactly one style element holding only the two rules of each forced package', () => {
    install({ admin: false, pluginCatalog: LOCKS });

    const styles = [...document.querySelectorAll(CATALOG_STYLE)];

    expect(styles).toHaveLength(1);
    expect(document.querySelectorAll(SANDBOX_STYLE)).toHaveLength(1);
    expect(styles[0].parentElement).toBe(document.head);
    expect(styles[0].hasAttribute(LOCK)).toBe(true);
    expect(styles[0].textContent).toBe(
      `[data-plugin-package="${LOCALE}"] button[role="switch"]{display:none !important}` +
        `[data-plugin-detail="${LOCALE}"] > :first-child button[role="switch"]:last-of-type{display:none !important}` +
        `[data-plugin-package="${OFFICE}"] button[role="switch"]{display:none !important}` +
        `[data-plugin-detail="${OFFICE}"] > :first-child button[role="switch"]:last-of-type{display:none !important}`,
    );
    expect(observers).toHaveLength(1);
  });

  it('locks cards and the detail switch rendered before the client arrives', () => {
    document.body.append(list(), detail(LOCALE));
    const before = document.body.innerHTML;

    install({ admin: false, pluginCatalog: LOCKS });

    expectDecorated();
    expect(dshMarkup()).toBe(before);
  });

  it('locks cards and the detail switch rendered after the client arrives', async () => {
    install({ admin: false, pluginCatalog: LOCKS });

    document.body.append(list());
    document.body.append(detail(LOCALE));
    await flush();

    expectDecorated();
  });

  it('locks a switch that DSH re-mounts inside an existing card', async () => {
    install({ admin: false, pluginCatalog: LOCKS });
    document.body.append(list());
    await flush();
    const end = cardSwitch(LOCALE).parentElement;

    end.replaceChildren(cardSwitch(LOCALE).cloneNode(true));
    await flush();

    expect(lockAfter(cardSwitch(LOCALE))).toEqual({ tag: 'SPAN', state: 'forced-on', text: ON });
    expect(marks(end)).toHaveLength(1);
  });

  it('never inserts a second mark or style on repeated mutations or a repeated apply', async () => {
    install({ admin: false, pluginCatalog: LOCKS });
    document.body.append(list(), detail(LOCALE));
    await flush();
    const locale = document.querySelector(`[data-plugin-package="${LOCALE}"]`);

    locale.parentElement.append(locale);
    cardSwitch(LOCALE).setAttribute('aria-checked', 'true');
    cardSwitch(LOCALE).parentElement.append(document.createElement('i'));
    document.querySelector('.detailActions').prepend(document.createElement('i'));
    install({ admin: false, pluginCatalog: LOCKS });
    await flush();

    expect(marks(document.body)).toHaveLength(3);
    expect(document.querySelectorAll(CATALOG_STYLE)).toHaveLength(1);
    expect(document.querySelectorAll(SANDBOX_STYLE)).toHaveLength(1);
    expect(observers).toHaveLength(1);
    expect(cardSwitch(LOCALE).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the native detail switch hidden after its mark follows it', async () => {
    install({ admin: false, pluginCatalog: { [LOCALE]: 'forced-on' } });

    document.body.append(detail(LOCALE));
    await flush();

    const native = topSwitch(LOCALE);
    expect(native.nextElementSibling.getAttribute(LOCK)).toBe('forced-on');
    expect(getComputedStyle(native).display).toBe('none');
    expect(shown(document.querySelector('[aria-label="row"]'))).toBe(true);
    expect(shown(document.querySelector(`[aria-label="卸载 ${LOCALE}"]`))).toBe(true);
  });

  it('keeps every DSH node and attribute unchanged and uses no network or console', async () => {
    install({ admin: false, pluginCatalog: LOCKS });
    const page = list();
    const before = page.outerHTML;

    document.body.append(page);
    await flush();
    for (const mark of marks(page)) mark.remove();

    expect(page.outerHTML).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('queries only added subtrees and inserts nothing while unrelated content streams in', async () => {
    document.body.append(list());
    install({ admin: false, pluginCatalog: LOCKS });
    const documentQueryAll = vi.spyOn(Document.prototype, 'querySelectorAll');
    const documentQuery = vi.spyOn(Document.prototype, 'querySelector');
    const elementQueryAll = vi.spyOn(Element.prototype, 'querySelectorAll');
    const elementQuery = vi.spyOn(Element.prototype, 'querySelector');
    const elementClosest = vi.spyOn(Element.prototype, 'closest');
    const added = new Set();
    const chat = document.createElement('main');
    document.body.append(chat);
    added.add(chat);

    for (let turn = 0; turn < 200; turn += 1) {
      const message = fromHtml(`<article><p>reply ${turn}</p><pre><code>x</code></pre></article>`);
      added.add(message);
      chat.append(message, document.createTextNode(`token ${turn}`));
    }
    await flush();
    const anchorChecks = [...elementQuery.mock.contexts, ...elementClosest.mock.contexts];
    const scans = elementQueryAll.mock.calls.length;
    const documentQueries = documentQueryAll.mock.calls.length + documentQuery.mock.calls.length;

    expect(documentQueries).toBe(0);
    expect(scans).toBe(0);
    expect(anchorChecks.length).toBeGreaterThan(0);
    for (const context of anchorChecks) expect(added.has(context)).toBe(true);
    expect(marks(chat)).toEqual([]);
    expect(document.body.querySelectorAll(`[${LOCK}]`)).toHaveLength(2);
  });
});

// The released dsh-better-sidebar 0.28.0 HTML viewer toggles (lib/client.js:2713-2716 zh,
// :3343-3346 en) and one other viewer toggle, rendered by FeatureSettingsRows/Switch
// (:31018-31035, :31044-31080): one `div.popupRow` per toggle, the title and description, then a
// `<label>` holding the checkbox (aria-label = title) and its track. Class names are hashed there.
const SANDBOX_ZH = ['关闭 HTML 预览沙箱（不安全）', 'HTML 预览默认以非沙箱模式打开（不安全）'];
const SANDBOX_EN = [
  'Disable HTML preview sandbox (unsafe)',
  'Open HTML previews unsandboxed by default (unsafe)',
];
const GIT_GUTTER = '编辑器未提交变更提示';
const SANDBOX_MARK = '沙箱开启 · 由管理员设定';

function settingRow(title, checked = false) {
  return fromHtml(`
    <div class="popupRow">
      <span class="rowText"><span class="title">${title}</span><span class="desc">desc</span></span>
      <label class="switch"><input type="checkbox" class="switchInput"${checked ? ' checked' : ''} aria-label="${title}"><span class="switchTrack" aria-hidden="true"><span class="switchThumb"></span></span></label>
    </div>`);
}

/** The released feature settings popup body with the given toggle titles. */
function settingsPopup(titles) {
  const rows = fromHtml('<div class="popupRows"></div>');
  rows.append(...titles.map((title) => settingRow(title)));
  return rows;
}

const switchLabel = (title) =>
  [...document.querySelectorAll('input[type="checkbox"]')]
    .find((input) => input.getAttribute('aria-label') === title)
    ?.closest('label');
const sandboxMarks = () => [...document.querySelectorAll(`span[${LOCK}="html-sandbox"]`)];

/** Each locked title's label is followed, outside it, by exactly one sandbox mark. */
function expectSandboxLocked(titles) {
  for (const title of titles) {
    const label = switchLabel(title);
    expect(lockAfter(label)).toEqual({ tag: 'SPAN', state: 'html-sandbox', text: SANDBOX_MARK });
    expect(label.querySelector(`[${LOCK}]`)).toBeNull();
    expect(label.parentElement.querySelectorAll(`[${LOCK}]`)).toHaveLength(1);
  }
}

describe('HTML preview sandbox lock display', () => {
  it('locks both Chinese and both English sandbox titles without any page global', async () => {
    install(undefined, false);
    document.body.append(settingsPopup([...SANDBOX_ZH, GIT_GUTTER]));
    document.body.append(settingsPopup(SANDBOX_EN));
    await flush();

    expectSandboxLocked([...SANDBOX_ZH, ...SANDBOX_EN]);
    expect(sandboxMarks()).toHaveLength(4);
  });

  it('leaves another viewer toggle and every DSH node as rendered', () => {
    document.body.append(settingsPopup([...SANDBOX_ZH, GIT_GUTTER]));
    const before = document.body.innerHTML;

    install({ admin: false });

    expect(lockAfter(switchLabel(GIT_GUTTER))).toBeNull();
    expect(switchLabel(GIT_GUTTER).parentElement.querySelector(`[${LOCK}]`)).toBeNull();
    expect(dshMarkup()).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('locks toggles rendered before the client arrives', () => {
    document.body.append(settingsPopup(SANDBOX_ZH));

    install({ admin: false, pluginCatalog: LOCKS });

    expectSandboxLocked(SANDBOX_ZH);
  });

  it('inserts one mark per row across re-renders, re-mounts and a repeated apply', async () => {
    install(undefined, false);
    const popup = settingsPopup(SANDBOX_ZH);
    document.body.append(popup);
    await flush();
    const [first] = SANDBOX_ZH;

    popup.append(popup.firstElementChild);
    const label = switchLabel(first);
    label.replaceChildren(...[...label.childNodes].map((node) => node.cloneNode(true)));
    label.parentElement.append(document.createElement('i'));
    install(undefined, false);
    await flush();

    expectSandboxLocked(SANDBOX_ZH);
    expect(sandboxMarks()).toHaveLength(2);
    expect(document.querySelectorAll(SANDBOX_STYLE)).toHaveLength(1);
    expect(observers).toHaveLength(1);
  });

  it('locks a popup that opens long after the client arrives', async () => {
    install(undefined, false);
    document.body.append(list());
    await flush();
    expect(sandboxMarks()).toEqual([]);

    const portal = document.createElement('div');
    document.body.append(portal);
    await flush();
    portal.append(settingsPopup(SANDBOX_EN));
    await flush();

    expectSandboxLocked(SANDBOX_EN);
  });

  it('hides each sandbox switch label by one rule per title, before its node appears', () => {
    install(undefined, false);

    const styles = [...document.querySelectorAll(SANDBOX_STYLE)];

    expect(styles).toHaveLength(1);
    expect(styles[0].parentElement).toBe(document.head);
    expect(styles[0].textContent).toBe(
      [...SANDBOX_ZH, ...SANDBOX_EN]
        .map((title) => `label:has(> input[aria-label="${title}"]){display:none !important}`)
        .join(''),
    );
    expect(document.querySelectorAll(CATALOG_STYLE)).toHaveLength(0);
  });

  it('keeps the catalog lock unchanged beside the sandbox lock on one page', async () => {
    install({ admin: false, pluginCatalog: LOCKS });
    document.body.append(list(), detail(LOCALE), settingsPopup(SANDBOX_ZH));
    await flush();

    expect(marks(document.body)).toHaveLength(5);
    expectSandboxLocked(SANDBOX_ZH);
    expect(lockAfter(cardSwitch(LOCALE))).toEqual({ tag: 'SPAN', state: 'forced-on', text: ON });
    expect(observers).toHaveLength(1);
  });
});
