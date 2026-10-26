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
}

interface FakeOptions {
  admin: boolean;
  showAdminLink?: boolean;
  railKeepsText?: boolean;
  cordisVisible?: boolean;
  consoleError?: boolean;
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
    ].map((href) => {
      const label = LABELS[href] ?? '';
      const compact = state.mode === 'rail' && options.railKeepsText !== true;
      return {
        href,
        text: compact ? '' : label,
        label: compact ? label : null,
        target: null,
        visible: true,
      };
    });
  const evaluate = (expression: string): unknown => {
    if (expression.includes('el.click()')) {
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
    }
    if (expression.includes('location.pathname')) {
      // The first read after navigation sees the replaced execution context.
      if (state.path !== '/' && !state.replaced) {
        state.replaced = true;
        throw new Error('context replaced');
      }
      return { path: state.path, search: '', heading: HEADINGS[state.path] ?? null };
    }
    if (expression.includes('data-cordis-badge')) {
      return {
        mode: state.mode,
        sharedFooter: true,
        cordisVisible: options.cordisVisible ?? true,
        links: links(),
      };
    }
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
    expect(evidence.destination).toEqual({ path, search: '', heading });
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
])('rejects %s', async (_name, options, admin, failure) => {
  const { result } = await run(options, 600, admin);

  await expect(result).rejects.toThrow(failure);
});
