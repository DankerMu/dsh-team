import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create } from 'react-test-renderer';

let registration;
vi.stubGlobal('window', { __ModuleLoader__: { load: (value) => (registration = value) } });
await import('./client.js');
vi.unstubAllGlobals();

const GLOBAL = '__DSH_TEAM_PLATFORM_NAV__';
const required = [];
const plugin = registration.factory((id) => {
  required.push(id);
  return React;
});
const injected = [];
const registered = [];
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

let fetchSpy;
let consoleSpies;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
    vi.spyOn(console, method),
  );
});
const mounted = [];
afterEach(() => {
  for (const view of mounted.splice(0)) act(() => view.unmount());
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
