import { afterEach, expect, it, vi } from 'vitest';
import { clearOriginState, cookieForms, cookiePaths } from './origin-state.ts';

type Outcome = 'success' | 'error' | 'blocked';

interface DeleteRequest {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubBrowser(
  options: {
    pathname?: string;
    hostname?: string;
    protocol?: string;
    cookie?: string | Error;
    outcomes?: Record<string, Outcome>;
    missing?: readonly ('databases' | 'serviceWorker' | 'caches')[];
  } = {},
) {
  const missing = new Set(options.missing ?? []);
  const outcomes = options.outcomes ?? { 'a-db': 'success', 'b-db': 'error' };
  const writes: string[] = [];
  const deleted: string[] = [];
  const unregister = [vi.fn(() => Promise.resolve(true)), vi.fn(() => Promise.resolve(true))];
  const localStorage = { clear: vi.fn() };
  const sessionStorage = { clear: vi.fn() };
  const caches = {
    keys: vi.fn(() => Promise.resolve(['a-cache', 'b-cache'])),
    delete: vi.fn(() => Promise.resolve(true)),
  };
  const indexedDB = {
    ...(missing.has('databases')
      ? {}
      : {
          databases: vi.fn(() =>
            Promise.resolve(Object.keys(outcomes).map((name) => ({ name, version: 1 }))),
          ),
        }),
    deleteDatabase: vi.fn((name: string) => {
      const request: DeleteRequest = { onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => {
        deleted.push(name);
        request[`on${outcomes[name] ?? 'success'}`]?.();
      });
      return request;
    }),
  };
  const serviceWorker = {
    getRegistrations: vi.fn(() =>
      Promise.resolve(unregister.map((entry) => ({ unregister: entry }))),
    ),
  };
  const document = {
    get cookie(): string {
      if (options.cookie instanceof Error) throw options.cookie;
      return options.cookie ?? '';
    },
    set cookie(value: string) {
      writes.push(value);
    },
  };
  vi.stubGlobal('window', {
    location: {
      pathname: options.pathname ?? '/_platform/login',
      hostname: options.hostname ?? '127.0.0.1',
      protocol: options.protocol ?? 'http:',
    },
    document,
    localStorage,
    sessionStorage,
    indexedDB,
    navigator: missing.has('serviceWorker') ? {} : { serviceWorker },
    ...(missing.has('caches') ? {} : { caches }),
  });
  return { writes, deleted, unregister, localStorage, sessionStorage, caches, indexedDB };
}

it('clears storage, every listed database, every worker registration and every cache', async () => {
  const browser = stubBrowser();

  await clearOriginState();

  expect(browser.localStorage.clear).toHaveBeenCalledOnce();
  expect(browser.sessionStorage.clear).toHaveBeenCalledOnce();
  expect(browser.indexedDB.deleteDatabase.mock.calls).toEqual([['a-db'], ['b-db']]);
  expect(browser.deleted.sort()).toEqual(['a-db', 'b-db']);
  for (const unregister of browser.unregister) expect(unregister).toHaveBeenCalledOnce();
  expect(browser.caches.delete.mock.calls).toEqual([['a-cache'], ['b-cache']]);
});

it('expires every script-visible cookie, bare fragments in nameless form, at every ancestor path', async () => {
  const browser = stubBrowser({ cookie: 'a_pref=1; theme=dark=x; platform_session' });

  await clearOriginState();

  const paths = ['/', '/_platform', '/_platform/', '/_platform/login'];
  expect(browser.writes).toEqual([
    ...['a_pref', 'theme'].flatMap((name) =>
      paths.map((path) => `${name}=; Path=${path}; Max-Age=0`),
    ),
    ...paths.map((path) => `platform_session; Path=${path}; Max-Age=0`),
  ]);
});

it('keeps parent-domain forms for platform_session and bare fragments only on a DNS host', async () => {
  const browser = stubBrowser({
    cookie: 'a_pref=1; platform_session=x; platform_session',
    pathname: '/_platform/account',
    hostname: 'dsh.corp.example',
    protocol: 'https:',
  });

  await clearOriginState();

  const preference = browser.writes.filter((write) => write.startsWith('a_pref='));
  const named = browser.writes.filter((write) => write.startsWith('platform_session='));
  const bare = browser.writes.filter((write) => write.startsWith('platform_session;'));
  expect(preference).toHaveLength(4 * 6);
  expect(preference.some((write) => write.includes('Domain=corp.example'))).toBe(false);
  expect(preference).toContain('a_pref=; Path=/; Domain=dsh.corp.example; Secure; Max-Age=0');
  expect(preference).toContain('a_pref=; Path=/_platform/; Partitioned; Secure; Max-Age=0');
  expect(named).toHaveLength(4 * 9);
  expect(named).toContain(
    'platform_session=; Path=/_platform/; Domain=corp.example; Partitioned; Secure; Max-Age=0',
  );
  expect(bare).toHaveLength(4 * 9);
  expect(bare).toContain('platform_session; Path=/; Domain=corp.example; Max-Age=0');
});

it.each(['127.0.0.1', '10.1.2.3', '[::1]', '[2001:db8::1]'])(
  'gives an IP literal %s the host-only form only',
  (hostname) => {
    expect(cookieForms(hostname, false)).toEqual(['']);
  },
);

it('forms cookies exactly as the server heal does', () => {
  expect(cookieForms('dsh.corp.example', false)).toEqual([
    '',
    '; Domain=dsh.corp.example',
    '; Domain=corp.example',
  ]);
  expect(cookieForms('localhost', false)).toEqual(['']);
  expect(cookieForms('corp.example', true)).toEqual([
    '',
    '; Secure',
    '; Partitioned; Secure',
    '; Domain=corp.example',
    '; Domain=corp.example; Secure',
    '; Domain=corp.example; Partitioned; Secure',
  ]);
  expect(cookieForms('127.0.0.1', true)).toEqual(['', '; Secure', '; Partitioned; Secure']);
});

it.each([
  ['/', ['/']],
  ['/_platform/login', ['/', '/_platform', '/_platform/', '/_platform/login']],
  ['/_platform/', ['/', '/_platform', '/_platform/']],
])('lists the cookie paths visible at %s', (pathname, expected) => {
  expect(cookiePaths(pathname)).toEqual(expected);
});

it('skips the database, worker and cache steps when their APIs are missing', async () => {
  const browser = stubBrowser({
    cookie: 'a_pref=1',
    missing: ['databases', 'serviceWorker', 'caches'],
  });

  await clearOriginState();

  expect(browser.localStorage.clear).toHaveBeenCalledOnce();
  expect(browser.sessionStorage.clear).toHaveBeenCalledOnce();
  expect(browser.indexedDB.deleteDatabase).not.toHaveBeenCalled();
  expect(browser.writes).toHaveLength(4);
});

it('runs every later step and resolves when earlier steps throw or reject', async () => {
  const browser = stubBrowser({ cookie: 'a_pref=1' });
  browser.localStorage.clear.mockImplementation(() => {
    throw new Error('storage denied');
  });
  browser.caches.keys.mockRejectedValue(new Error('cache denied'));
  browser.unregister[0]?.mockRejectedValue(new Error('worker denied'));
  browser.indexedDB.deleteDatabase.mockImplementationOnce(() => {
    throw new Error('database denied');
  });

  await expect(clearOriginState()).resolves.toBeUndefined();

  expect(browser.sessionStorage.clear).toHaveBeenCalledOnce();
  expect(browser.unregister[1]).toHaveBeenCalledOnce();
  expect(browser.deleted).toEqual(['b-db']);
  expect(browser.writes).toHaveLength(4);
});

it('resolves when a database deletion is blocked by another tab', async () => {
  const browser = stubBrowser({ outcomes: { 'held-db': 'blocked' } });

  await clearOriginState();

  expect(browser.deleted).toEqual(['held-db']);
});

it('resolves when reading the cookie list throws', async () => {
  const browser = stubBrowser({ cookie: new Error('cookies denied') });

  await expect(clearOriginState()).resolves.toBeUndefined();

  expect(browser.writes).toEqual([]);
  expect(browser.localStorage.clear).toHaveBeenCalledOnce();
});
