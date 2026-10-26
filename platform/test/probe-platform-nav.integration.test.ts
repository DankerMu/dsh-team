import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyPlatformNav } from '../../scripts/probe-platform-nav.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Link {
  href: string;
  text: string;
  label: string | null;
  target: string | null;
  visible: boolean;
  contained: boolean;
  labelFits: boolean;
}

interface FakeOptions {
  admin: boolean;
  showAdminLink?: boolean;
  railKeepsText?: boolean;
  cordisVisible?: boolean;
  consoleError?: boolean;
  /** The entry is not the slot anchor's child, so its cell does not hold Cordis. */
  outsideSlot?: boolean;
  /** The entry renders beside, not below, the Cordis badge in this mode. */
  besideCordis?: 'wide' | 'rail';
  /** The last link leaves the footer cell horizontally in this mode. */
  overflowing?: 'wide' | 'rail';
  /** The last wide label is truncated. */
  truncatedLabel?: boolean;
  /** The shared footer cell is outside the viewport. */
  cellOffscreen?: boolean;
  /** The administrator console page lacks its 返回工作台 link. */
  noWorkbench?: boolean;
}

const LABELS: Record<string, string> = {
  '/_platform/account': '账号设置',
  '/_platform/admin': '管理后台',
};
const HEADINGS: Record<string, string> = {
  '/_platform/account': '修改密码',
  '/_platform/admin': '账号管理',
};

/** Scripted CDP page: answers the evidence module's own DOM expressions by page state. */
function fakePage(options: FakeOptions, errors: unknown[]) {
  const state = { mode: 'wide', path: '/', clicks: [] as string[], replaced: false };
  const links = (): Link[] =>
    [
      '/_platform/account',
      ...(options.admin || options.showAdminLink ? ['/_platform/admin'] : []),
    ].map((href, index, all) => {
      const label = LABELS[href] ?? '';
      const compact = state.mode === 'rail' && options.railKeepsText !== true;
      const last = index === all.length - 1;
      return {
        href,
        text: compact ? '' : label,
        label: compact ? label : null,
        target: null,
        visible: true,
        contained: !(last && options.overflowing === state.mode),
        labelFits: !(last && state.mode === 'wide' && options.truncatedLabel === true),
      };
    });
  const click = (expression: string): boolean => {
    const selector = /querySelector\(("(?:[^"\\]|\\.)*")\)/.exec(expression)?.[1];
    const parsed: unknown = JSON.parse(selector ?? '""');
    const text = String(parsed);
    state.clicks.push(text);
    if (text.includes('收起侧边栏')) state.mode = 'rail';
    else if (text.includes('打开侧边栏')) state.mode = 'wide';
    else {
      state.path = /href="([^"]+)"/.exec(text)?.[1] ?? state.path;
      if (options.consoleError === true) errors.push('platform-page');
    }
    return true;
  };
  const destination = (expression: string) => {
    // The first read after navigation sees the replaced execution context.
    if (state.path !== '/' && !state.replaced) {
      state.replaced = true;
      throw new Error('context replaced');
    }
    const page = { path: state.path, search: '', heading: HEADINGS[state.path] ?? null };
    if (!expression.includes('返回工作台')) return page;
    const workbench =
      options.noWorkbench === true ? null : { href: '/', text: '返回工作台', visible: true };
    return { ...page, workbench };
  };
  const sidebar = () => ({
    mode: state.mode,
    sharedFooter: options.outsideSlot !== true,
    cordisVisible: options.cordisVisible ?? true,
    stacked: options.besideCordis !== state.mode,
    cellInViewport: options.cellOffscreen !== true,
    links: links(),
  });
  const evaluate = (expression: string): unknown => {
    if (expression.includes('el.click()')) return click(expression);
    if (expression.includes('location.pathname')) return destination(expression);
    if (expression.includes('data-cordis-badge')) return sidebar();
    throw new Error(`unexpected expression ${expression.slice(0, 40)}`);
  };
  return {
    state,
    page: {
      send(method: string, params: { expression?: string }) {
        if (method === 'Page.captureScreenshot')
          return Promise.resolve({ data: Buffer.from('png').toString('base64') });
        if (method !== 'Runtime.evaluate') return Promise.reject(new Error(method));
        try {
          return Promise.resolve({ result: { value: evaluate(params.expression ?? '') } });
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    },
  };
}

async function run(options: FakeOptions, ms = 3_000, admin = options.admin) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-platform-nav-'));
  roots.push(root);
  const errors: unknown[] = [];
  const { page, state } = fakePage(options, errors);
  const result = verifyPlatformNav({
    page,
    admin,
    errors,
    screenshot: join(root, 'entry.png'),
    ms,
  });
  return { result, state, root };
}

it.each([
  [false, '/_platform/account', '修改密码', ['账号设置']],
  [true, '/_platform/admin', '账号管理', ['账号设置', '管理后台']],
])(
  'accepts admin=%s wide and compact links, then follows the role link to %s',
  async (admin, path, heading, labels) => {
    const { result, state, root } = await run({ admin });

    const evidence = await result;

    expect(evidence.wide.map(({ text }) => text)).toEqual(labels);
    expect(evidence.rail.map(({ label, text }) => [label, text])).toEqual(
      labels.map((label) => [label, '']),
    );
    expect(evidence.wide.every((link) => link.contained && link.labelFits)).toBe(true);
    expect(evidence.rail.every((link) => link.contained && link.labelFits)).toBe(true);
    expect(evidence.destination).toEqual(
      admin
        ? { path, search: '', heading, workbench: { href: '/', text: '返回工作台', visible: true } }
        : { path, search: '', heading },
    );
    expect(state.clicks).toEqual([
      'button[aria-label="收起侧边栏"]',
      'button[aria-label="打开侧边栏"]',
      `[data-dsh-team-platform-nav] a[href="${path}"]`,
    ]);
    expect((await readdir(root)).sort()).toEqual([
      'entry-platform-nav-destination.png',
      'entry-platform-nav-rail.png',
      'entry-platform-nav-wide.png',
    ]);
  },
);

it.each<[string, FakeOptions, boolean, RegExp]>([
  ['an employee shown the console link', { admin: false, showAdminLink: true }, false, /nav-wide/],
  ['an administrator page without the console link', { admin: false }, true, /nav-wide/],
  ['a rail that keeps text labels', { admin: false, railKeepsText: true }, false, /nav-rail/],
  ['a hidden Cordis action', { admin: true, cordisVisible: false }, true, /nav-wide/],
  ['a console error after navigation', { admin: false, consoleError: true }, false, /console/],
  [
    'an entry outside the footer slot anchor',
    { admin: false, outsideSlot: true },
    false,
    /nav-wide/,
  ],
  ['a wide entry beside Cordis', { admin: true, besideCordis: 'wide' }, true, /nav-wide/],
  ['a rail entry beside Cordis', { admin: true, besideCordis: 'rail' }, true, /nav-rail/],
  ['a wide link outside the footer cell', { admin: true, overflowing: 'wide' }, true, /nav-wide/],
  ['a rail link outside the footer cell', { admin: true, overflowing: 'rail' }, true, /nav-rail/],
  ['a truncated wide label', { admin: true, truncatedLabel: true }, true, /nav-wide/],
  ['a footer cell outside the viewport', { admin: false, cellOffscreen: true }, false, /nav-wide/],
  ['a console page without 返回工作台', { admin: true, noWorkbench: true }, true, /destination/],
])('rejects %s', async (_name, options, admin, failure) => {
  const { result } = await run(options, 600, admin);

  await expect(result).rejects.toThrow(failure);
});
