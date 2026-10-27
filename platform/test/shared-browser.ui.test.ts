import { mkdtemp, rm } from 'node:fs/promises';
import type { RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { observeAccountUi, withAccountUi } from './account-ui-fixture.ts';

// Owned employee-controlled destination; no request interception, so Chromium's HTTP cache is real.
const SCRIPT = '/assets/app-1a2b3c4d.js';
// Named, or nameless: the browser stores `platform_session` without `=` as an empty name.
const PLANTED = {
  named: `platform_session=${'c'.repeat(64)}; Path=/_platform/api; Max-Age=86400`,
  nameless: 'platform_session; Path=/_platform/api; Max-Age=86400',
};
type Plant = keyof typeof PLANTED | 'none';
const PASSWORD = 'shared-browser-password';

// Inline in the uncached HTML, so a cache hit on the marker script cannot replay it.
function poison(plant: Plant): string {
  return `<script>(async () => {
  localStorage.setItem('a', '1');
  sessionStorage.setItem('a', '1');
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('a-db', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onsuccess = () => { open.result.close(); resolve(); };
    open.onerror = () => reject(open.error);
  });
  await (await caches.open('a-cache')).put('/a-cached', new Response('A'));
  document.cookie = 'a_pref=1; Path=/; Max-Age=86400';
  ${plant === 'none' ? '' : `document.cookie = '${PLANTED[plant]}';`}
  document.body.dataset.written = 'true';
})();</script>`;
}

function employeeUpstream(plant: Plant) {
  const state = {
    phase: 'A' as 'A' | 'B',
    scripts: [] as ('A' | 'B')[],
    workers: [] as (string | undefined)[],
  };
  const handler: RequestListener = (request, response) => {
    if (request.url === '/') {
      const inline = state.phase === 'A' ? poison(plant) : '';
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>workbench</title></head><body><p id="marker"></p><script src="${SCRIPT}"></script>${inline}</body></html>`,
      );
    } else if (request.url === SCRIPT) {
      state.scripts.push(state.phase);
      response.writeHead(200, {
        'Content-Type': 'text/javascript',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      response.end(`document.getElementById('marker').textContent = '${state.phase}';`);
    } else if (request.url === '/sw.js') {
      const header = request.headers['service-worker'];
      state.workers.push(Array.isArray(header) ? header.join(',') : header);
      response.writeHead(200, {
        'Content-Type': 'text/javascript',
        'Cache-Control': 'public, max-age=31536000',
      });
      response.end('// owned test worker\n');
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('missing');
    }
  };
  return { state, handler };
}

// Chromium supplies these APIs; the root Node config intentionally has no DOM lib.
type BrowserOrigin = typeof globalThis & {
  localStorage: { length: number };
  sessionStorage: { length: number };
  indexedDB: { databases(): Promise<{ name?: string }[]> };
  caches: { keys(): Promise<string[]> };
  document: { cookie: string };
  navigator: {
    serviceWorker: {
      register(url: string, options: { scope: string; updateViaCache: string }): Promise<unknown>;
      getRegistrations(): Promise<unknown[]>;
    };
  };
};

function readOriginState(page: Page) {
  return page.evaluate(async () => {
    const browser = globalThis as BrowserOrigin;
    return {
      storage: [browser.localStorage.length, browser.sessionStorage.length],
      databases: (await browser.indexedDB.databases()).map((database) => database.name),
      caches: await browser.caches.keys(),
      cookie: browser.document.cookie,
    };
  });
}

function readSession(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('/_platform/api/session');
    return { status: response.status, body: await response.json() };
  });
}

async function login(page: Page, baseUrl: string, email: string) {
  await page.goto(`${baseUrl}/_platform/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(PASSWORD);
  const [response] = await Promise.all([
    page.waitForResponse((entry) => entry.url() === `${baseUrl}/_platform/api/login`),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(`${baseUrl}/`);
  await expect(page.locator('#marker')).not.toBeEmpty();
}

async function registerBoth(seed: { post: (url: string, options: object) => Promise<unknown> }) {
  for (const email of ['a@example.com', 'b@example.com']) {
    const registered = (await seed.post('/_platform/api/register', {
      data: { email, password: PASSWORD },
    })) as { status(): number };
    expect(registered.status()).toBe(201);
  }
}

for (const plant of ['named', 'nameless'] as const)
  test(`a second user after a browser restart reaches their own instance with none of the first session left (${plant} shadow)`, async ({
    playwright,
  }, testInfo) => {
    test.setTimeout(60_000);
    const upstream = employeeUpstream(plant);
    const profile = await mkdtemp(join(tmpdir(), 'dsh-team-shared-profile-'));
    let context: BrowserContext | undefined;
    const launch = async () => {
      context = await playwright.chromium.launchPersistentContext(profile, {
        viewport: { width: 1280, height: 800 },
      });
      return context.pages()[0] ?? (await context.newPage());
    };
    try {
      await withAccountUi(
        playwright,
        async ({ baseUrl, seed }) => {
          await registerBoth(seed);
          const endpoints = [`${baseUrl}/_platform/api/login`, `${baseUrl}/_platform/api/session`];
          const first = await launch();
          const observedA = observeAccountUi(first, testInfo, baseUrl, endpoints);

          await login(first, baseUrl, 'a@example.com');
          await expect(first.locator('body')).toHaveAttribute('data-written', 'true');
          await observedA.screenshot('shared-browser-restart-a');
          const worker = await first.evaluate(async () => {
            const browser = globalThis as BrowserOrigin;
            await (await fetch('/sw.js')).text();
            let registration = 'registered';
            try {
              await browser.navigator.serviceWorker.register('/sw.js', {
                scope: '/',
                updateViaCache: 'all',
              });
            } catch {
              registration = 'rejected';
            }
            return {
              registration,
              registrations: (await browser.navigator.serviceWorker.getRegistrations()).length,
            };
          });
          await context?.close();
          upstream.state.phase = 'B';
          const second = await launch();
          const observedB = observeAccountUi(second, testInfo, baseUrl, endpoints);
          await login(second, baseUrl, 'b@example.com');
          await observedB.screenshot('shared-browser-restart-b');

          expect({
            worker,
            workerUpstream: upstream.state.workers,
            marker: await second.locator('#marker').textContent(),
            scripts: upstream.state.scripts,
            origin: await readOriginState(second),
            session: await readSession(second),
          }).toEqual({
            worker: { registration: 'rejected', registrations: 0 },
            workerUpstream: [undefined],
            marker: 'B',
            scripts: ['A', 'B'],
            origin: { storage: [0, 0], databases: [], caches: [], cookie: '' },
            session: { status: 200, body: { email: 'b@example.com', role: 'employee' } },
          });
          // Observed after the restart so a RED run reports every combined fact first.
          observedA.expectHealthy(
            [],
            [],
            [
              {
                text: 'A bad HTTP response code (403) was received when fetching the script.',
                url: '',
              },
            ],
          );
          expect(observedB.otherMutations).toEqual([]);
          observedB.expectHealthy([]);
        },
        { upstream: upstream.handler },
      );
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });

test('logging out clears the storage, databases, caches and script cookies the instance left', async ({
  page,
  playwright,
}, testInfo) => {
  const upstream = employeeUpstream('none');
  await withAccountUi(
    playwright,
    async ({ baseUrl, seed }) => {
      await registerBoth(seed);
      const logoutUrl = `${baseUrl}/_platform/api/logout`;
      const observed = observeAccountUi(page, testInfo, baseUrl, [
        `${baseUrl}/_platform/api/login`,
        logoutUrl,
      ]);
      await login(page, baseUrl, 'a@example.com');
      await expect(page.locator('body')).toHaveAttribute('data-written', 'true');
      expect((await readOriginState(page)).databases).toEqual(['a-db']);

      await page.goto(`${baseUrl}/_platform/account`, { waitUntil: 'networkidle' });
      const [loggedOut] = await Promise.all([
        page.waitForResponse((response) => response.url() === logoutUrl),
        page.getByRole('button', { name: '退出登录', exact: true }).click(),
      ]);
      expect(loggedOut.status()).toBe(204);
      await expect(page).toHaveURL(`${baseUrl}/_platform/login`);
      await expect(page.getByRole('heading', { name: '登录 DSH 团队平台' })).toBeVisible();
      await observed.screenshot('shared-browser-logged-out');

      expect(await readOriginState(page)).toEqual({
        storage: [0, 0],
        databases: [],
        caches: [],
        cookie: '',
      });
      expect(await page.context().cookies()).toEqual([]);
      expect(upstream.state.scripts).toEqual(['A']);
      observed.expectHealthy([], [loggedOut.request()]);
    },
    { upstream: upstream.handler },
  );
});

test('a second user in the same browser after the first user closes their tabs reaches their own instance', async ({
  page,
  playwright,
}, testInfo) => {
  const upstream = employeeUpstream('named');
  await withAccountUi(
    playwright,
    async ({ baseUrl, seed }) => {
      await registerBoth(seed);
      const endpoints = [`${baseUrl}/_platform/api/login`, `${baseUrl}/_platform/api/session`];
      const observedA = observeAccountUi(page, testInfo, baseUrl, endpoints);
      await login(page, baseUrl, 'a@example.com');
      await expect(page.locator('body')).toHaveAttribute('data-written', 'true');
      observedA.expectHealthy([]);
      const context = page.context();
      await page.close();

      upstream.state.phase = 'B';
      const next = await context.newPage();
      const observedB = observeAccountUi(next, testInfo, baseUrl, endpoints);
      await login(next, baseUrl, 'b@example.com');
      await observedB.screenshot('shared-browser-closed-tabs-b');

      expect({
        marker: await next.locator('#marker').textContent(),
        scripts: upstream.state.scripts,
        origin: await readOriginState(next),
        session: await readSession(next),
      }).toEqual({
        marker: 'B',
        scripts: ['A', 'B'],
        origin: { storage: [0, 0], databases: [], caches: [], cookie: '' },
        session: { status: 200, body: { email: 'b@example.com', role: 'employee' } },
      });
      observedB.expectHealthy([]);
    },
    { upstream: upstream.handler },
  );
});
