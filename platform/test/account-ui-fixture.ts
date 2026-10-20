import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  type APIRequestContext,
  type Page,
  type PlaywrightWorkerArgs,
  type Request,
  type TestInfo,
} from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { byteListener } from '../../scripts/byte-listener.mjs';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { applyMigrations, openDatabase, type DatabaseHandle } from '../src/db/index.ts';
import type { GatewayUpstream } from '../src/gateway/index.ts';
import {
  createDockerClient,
  createInstanceService,
  type InstanceService,
} from '../src/orchestrator/index.ts';
import { assertWebBuild } from '../src/web/index.ts';
import { withUpstream } from './gateway-http-fixture.ts';

export function observeAccountUi(
  page: Page,
  testInfo: TestInfo,
  baseUrl: string,
  credentialUrl: string | readonly string[],
) {
  const endpoints = typeof credentialUrl === 'string' ? [credentialUrl] : credentialUrl;
  const consoleErrors: { text: string; url: string }[] = [];
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  const failedRequests: { request: Request; errorText: string | undefined }[] = [];
  const observedStatuses = new Map<Request, number>();
  const requests: string[] = [];
  const statuses: number[] = [];
  const otherMutations: string[] = [];
  const actionRequests: { url: string; method: string }[] = [];
  const actionResponses: { url: string; status: number }[] = [];
  const unexpectedAuthRequests: string[] = [];
  const freshAssets = new Set<string>();
  const assets: { url: string; status: number; hasFreshRepresentation: boolean }[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) =>
    failedRequests.push({ request, errorText: request.failure()?.errorText }),
  );
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== baseUrl) externalRequests.push(request.url());
    if (endpoints.includes(request.url())) {
      requests.push(request.method());
      actionRequests.push({ url: request.url(), method: request.method() });
    } else {
      if (!['GET', 'HEAD'].includes(request.method())) otherMutations.push(request.url());
      if (new URL(request.url()).pathname.startsWith('/_platform/api/'))
        unexpectedAuthRequests.push(request.url());
    }
  });
  page.on('response', (response) => {
    if (endpoints.includes(response.url())) {
      observedStatuses.set(response.request(), response.status());
      statuses.push(response.status());
      actionResponses.push({ url: response.url(), status: response.status() });
    }
    if (new URL(response.url()).pathname.startsWith('/_platform/assets/')) {
      const url = response.url();
      const status = response.status();
      // Revalidation is valid only after this browser observed that exact URL's fresh bytes.
      const hasFreshRepresentation = freshAssets.has(url);
      if (status === 200) freshAssets.add(url);
      assets.push({ url, status, hasFreshRepresentation });
    }
  });
  return {
    requests,
    statuses,
    otherMutations,
    actionRequests,
    actionResponses,
    screenshot: async (name: string) => {
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(name, { path, contentType: 'image/png' });
    },
    expectHealthy: (
      rejections: readonly number[] | readonly { url: string; status: number }[],
      confirmedNoContentRequests: readonly Request[] = [],
    ) => {
      for (const asset of assets) {
        expect(
          asset.status === 200 || (asset.status === 304 && asset.hasFreshRepresentation),
          `Asset ${asset.url} returned ${String(asset.status)} without a valid representation`,
        ).toBe(true);
      }
      // Each exact endpoint diagnostic consumes one observed rejection's status allowance.
      // Fewer diagnostics are fine; a different URL, status, message or excess count is not.
      const allowances = rejections.map((rejection) =>
        typeof rejection === 'number'
          ? { url: typeof credentialUrl === 'string' ? credentialUrl : '', status: rejection }
          : rejection,
      );
      const observed = [...actionResponses];
      for (const rejection of allowances) {
        const index = observed.findIndex(
          (response) => response.url === rejection.url && response.status === rejection.status,
        );
        expect(
          index,
          'Expected rejection must have occurred at its exact endpoint',
        ).toBeGreaterThanOrEqual(0);
        observed.splice(index, 1);
      }
      for (const error of consoleErrors) {
        const match =
          /^Failed to load resource: the server responded with a status of (\d{3}) \([^\n]+\)$/.exec(
            error.text,
          );
        expect(match).not.toBeNull();
        const index = allowances.findIndex(
          (rejection) => rejection.url === error.url && rejection.status === Number(match?.[1]),
        );
        expect(index).toBeGreaterThanOrEqual(0);
        allowances.splice(index, 1);
      }
      expect(pageErrors).toEqual([]);
      // Test-only: Chromium can report ERR_ABORTED after a committed 204 fetch.
      // Callers must separately prove status and effects before confirming exact identities.
      const confirmed = new Set(confirmedNoContentRequests);
      expect(confirmed.size, 'Confirmed no-content request identities must be unique').toBe(
        confirmedNoContentRequests.length,
      );
      for (const request of confirmed) {
        expect(
          observedStatuses.get(request),
          'Confirmed no-content request must have an observed 204 at a tracked endpoint',
        ).toBe(204);
      }
      for (const { request, errorText } of failedRequests) {
        expect(
          confirmed.has(request),
          `Failed request ${request.url()} must be explicitly confirmed by identity`,
        ).toBe(true);
        expect(request.method(), 'Confirmed failed request must be POST').toBe('POST');
        expect(
          endpoints.includes(request.url()),
          'Confirmed failed request must target a tracked endpoint',
        ).toBe(true);
        expect(
          observedStatuses.get(request),
          'Confirmed failed request must have its own observed 204 response',
        ).toBe(204);
        expect(errorText, 'Only the exact Chromium no-content abort is allowed').toBe(
          'net::ERR_ABORTED',
        );
      }
      expect(externalRequests).toEqual([]);
      expect(unexpectedAuthRequests).toEqual([]);
    },
  };
}

export async function expectNoBrowserStorage(page: Page): Promise<void> {
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
}

export async function expectNoScriptVisibleCookie(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => {
      // Chromium supplies document; the root Node config intentionally has no DOM lib.
      const browser = globalThis as typeof globalThis & {
        document: { cookie: string };
      };
      return browser.document.cookie;
    }),
  ).toBe('');
}

export async function submitPendingAccountForm(page: Page, name: string): Promise<void> {
  await page.getByRole('form', { name }).evaluate((element: unknown) => {
    // Chromium supplies the DOM constructor; the root Node config has no DOM lib.
    const browser = globalThis as typeof globalThis & {
      HTMLFormElement: new () => { requestSubmit(): void };
    };
    if (!(element instanceof browser.HTMLFormElement)) throw new Error('Missing account form');
    element.requestSubmit();
    element.requestSubmit();
  });
}

export async function withAccountUiRouteCleanup(
  page: Page,
  run: (release: PromiseWithResolvers<undefined>) => Promise<void>,
): Promise<void> {
  const release = Promise.withResolvers<undefined>();
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    await run(release);
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }
  // Release even after browser teardown; drain only a still-open owned page.
  release.resolve(undefined);
  if (!page.isClosed()) {
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } catch (error) {
      // A teardown race must not replace the original assertion or timeout failure.
      if (!primaryFailed) throw error;
    }
  }
  if (primaryFailed) throw primaryError;
}

export interface AccountUiContext {
  baseUrl: string;
  database: DatabaseHandle;
  seed: APIRequestContext;
  target: GatewayUpstream;
  upstreamRequests: { path: string; cookie: string | undefined }[];
  admittedUsers: string[];
}

export interface AccountUiOptions {
  canonicalInstanceService?: boolean;
  /** An owned Engine-protocol dependency; omitted means the existing unavailable socket. */
  dockerSocketPath?: string;
  observeInitialization?: (
    context:
      | { phase: 'origin-selected'; baseUrl: string }
      | {
          phase: 'application-built';
          baseUrl: string;
          app: FastifyInstance;
          database: DatabaseHandle;
        },
  ) => void | Promise<void>;
}

function accountUiConfig(directory: string, port: number, options: AccountUiOptions) {
  return loadConfig({
    PLATFORM_HOST: '127.0.0.1',
    PLATFORM_PORT: String(port),
    PLATFORM_PUBLIC_URL: `http://127.0.0.1:${String(port)}`,
    PLATFORM_DATA_DIR: directory,
    PLATFORM_LOG_LEVEL: 'silent',
    PLATFORM_COOKIE_SECURE: 'false',
    ...(options.canonicalInstanceService === true
      ? {
          PLATFORM_DOCKER_SOCKET:
            options.dockerSocketPath ?? join(directory, 'unavailable-docker.sock'),
          ...(options.dockerSocketPath === undefined
            ? {}
            : { PLATFORM_UPSTREAM_MODE: 'published-loopback' }),
        }
      : {}),
  });
}

export async function withAccountUi(
  playwright: PlaywrightWorkerArgs['playwright'],
  run: (context: AccountUiContext) => Promise<void>,
  options: AccountUiOptions = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-web-ui-'));
  let database: DatabaseHandle | undefined;
  let app: FastifyInstance | undefined;
  let service: InstanceService | undefined;
  let seed: APIRequestContext | undefined;
  let listener: ReturnType<typeof byteListener> | undefined;
  let primary: unknown;
  let failed = false;
  const initialization = { upstreamEntered: false };
  let listenerRetired = false;
  const cleanup: unknown[] = [];
  const settle = async (operation: () => void | Promise<void>) => {
    try {
      await operation();
      return true;
    } catch (error) {
      cleanup.push(error);
      return false;
    }
  };
  const retireListener = async () => {
    if (listenerRetired) return;
    listenerRetired = true;
    await settle(() => listener?.close());
  };
  try {
    await assertWebBuild();
    const publicListener = byteListener({ host: '127.0.0.1', port: 0 });
    listener = publicListener;
    await publicListener.ready;
    const address = publicListener.server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing UI TCP address');
    const config = accountUiConfig(directory, address.port, options);
    const baseUrl = config.publicUrl;
    await options.observeInitialization?.({ phase: 'origin-selected', baseUrl });
    database = openDatabase(join(directory, 'platform.db'));
    applyMigrations(database);
    const upstreamRequests: { path: string; cookie: string | undefined }[] = [];
    const admittedUsers: string[] = [];
    // This owned plain-text destination observes gateway admission; it is NOT DSH evidence.
    await withUpstream(
      (request, response) => {
        upstreamRequests.push({ path: request.url ?? '', cookie: request.headers.cookie });
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('本地已认证入口（非 DSH）');
      },
      async (target) => {
        initialization.upstreamEntered = true;
        try {
          // Default callers retain their local destination; admin actions opt into the real lifecycle.
          if (database === undefined) throw new Error('Missing UI database');
          if (options.canonicalInstanceService === true)
            service = createInstanceService({
              client: createDockerClient(config.dockerSocketPath),
              database,
              config,
            });
          app = await buildApp(
            config,
            database,
            undefined,
            (userId) => {
              admittedUsers.push(userId);
              return target;
            },
            service,
          );
          await options.observeInitialization?.({
            phase: 'application-built',
            baseUrl,
            app,
            database,
          });
          await app.listen({ host: '127.0.0.1', port: 0 });
          const backend = app.server.address();
          if (backend === null || typeof backend === 'string')
            throw new Error('Missing UI backend address');
          publicListener.forwardTo({ host: '127.0.0.1', port: backend.port });
          // Separate API cookie jar: account seeding never preauthenticates the browser.
          seed = await playwright.request.newContext({
            baseURL: baseUrl,
            extraHTTPHeaders: { Origin: baseUrl },
          });
          await run({ baseUrl, database, seed, target, upstreamRequests, admittedUsers });
        } catch (error) {
          primary = error;
          failed = true;
        } finally {
          // Fence public admission before the independently owned upstream begins teardown.
          await retireListener();
        }
      },
    );
  } catch (error) {
    if (initialization.upstreamEntered) cleanup.push(error);
    else {
      primary = error;
      failed = true;
    }
  }
  await retireListener();
  await settle(() => seed?.dispose());
  // An initialized app owns service drainage and SQLite. Do not close SQLite beneath
  // unconfirmed lifecycle work merely to make fixture cleanup appear complete.
  if (app === undefined) {
    const serviceSettled = await settle(() => service?.close());
    if (serviceSettled)
      await settle(() => {
        database?.close();
      });
  } else {
    const ownedApp = app;
    await settle(() => ownedApp.close());
  }
  // withUpstream reports combined setup/retirement uncertainty as an AggregateError.
  if (
    cleanup.length === 0 &&
    !(!initialization.upstreamEntered && primary instanceof AggregateError)
  )
    await settle(() => rm(directory, { recursive: true, force: true }));
  if (cleanup.length !== 0) {
    if (failed)
      throw new AggregateError([primary, ...cleanup], 'UI operation and cleanup failed', {
        cause: primary,
      });
    throw cleanup[0];
  }
  if (failed) throw primary;
}
