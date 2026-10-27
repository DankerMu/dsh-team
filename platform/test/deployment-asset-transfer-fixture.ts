import { once } from 'node:events';
import { request } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { buffer } from 'node:stream/consumers';
import { gunzipSync } from 'node:zlib';
import { expect } from 'vitest';
import type { Deployment } from './deployment-fixture.ts';

const DSH_IMMUTABLE = 'public, max-age=31536000, immutable';
const GATEWAY_IMMUTABLE = 'private, max-age=31536000, immutable';

// The gateway keys every workbench response by session; DSH's own Vary tokens are not asserted here.
function expectSessionVary(headers: IncomingHttpHeaders, label: string): void {
  const tokens = (headers.vary ?? '').split(',').map((token) => token.trim().toLowerCase());
  expect(
    tokens.filter((token) => token === 'cookie'),
    `${label} Vary`,
  ).toHaveLength(1);
}

// fetch adds Accept-Encoding itself and decodes silently; node:http keeps the actual wire bytes.
function open(
  deployment: Deployment,
  cookie: string,
  path: string,
  encoding?: string,
): Promise<IncomingMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  const headers = encoding === undefined ? { cookie } : { cookie, 'accept-encoding': encoding };
  const call = request(
    deployment.base,
    { path, headers, agent: false, signal: AbortSignal.timeout(60_000) },
    resolve,
  );
  call.once('error', reject);
  call.end();
  return promise;
}

async function receive(deployment: Deployment, cookie: string, path: string, encoding?: string) {
  const response = await open(deployment, cookie, path, encoding);
  const body = await buffer(response);
  expect(response.statusCode, path).toBe(200);
  return { headers: response.headers, body };
}

async function firstEventFrame(deployment: Deployment, cookie: string): Promise<unknown> {
  const events = await open(deployment, cookie, '/plugins/events', 'gzip');
  const closed = once(events, 'close');
  try {
    expect(events.statusCode).toBe(200);
    expect(events.headers['content-type']).toBe('text/event-stream');
    expect(events.headers['content-encoding']).toBeUndefined();
    expect(events.headers['cache-control']).toBe('no-cache');
    expectSessionVary(events.headers, '/plugins/events');
    const frame = Promise.withResolvers<string>();
    let text = '';
    events.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      const match = /^: connected\n\ndata: ([^\n]*)\n\n/.exec(text);
      if (match?.[1] !== undefined) frame.resolve(match[1]);
    });
    events.once('error', frame.reject);
    events.once('end', () => {
      frame.reject(new Error('DSH event stream ended before its first frame'));
    });
    return JSON.parse(await frame.promise) as unknown;
  } finally {
    events.destroy();
    await closed;
  }
}

export async function verifyAssetTransfer(deployment: Deployment, cookie: string) {
  const page = await receive(deployment, cookie, '/');
  expect(page.headers['content-encoding']).toBeUndefined();
  expect(page.headers['cache-control']).toBeUndefined();
  expectSessionVary(page.headers, '/');
  const html = page.body.toString();
  const combos = [...html.matchAll(/(?:src|href)="(plugins\/\?\?[^"]+)"/g)].map(
    (match) => `/${String(match[1]).replaceAll('&amp;', '&')}`,
  );
  expect(combos.length).toBeGreaterThan(0);
  let largest = { path: '', body: Buffer.alloc(0) };
  for (const path of combos) {
    const identity = await receive(deployment, cookie, path, 'identity');
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(identity.headers['cache-control']).toBe(DSH_IMMUTABLE);
    expectSessionVary(identity.headers, path);
    if (identity.body.length > largest.body.length) largest = { path, body: identity.body };
  }
  const gzip = await receive(deployment, cookie, largest.path, 'gzip');
  expect(gzip.headers['content-encoding']).toBe('gzip');
  expect(gzip.headers['cache-control']).toBe(DSH_IMMUTABLE);
  expectSessionVary(gzip.headers, `${largest.path} gzip`);
  expect(gzip.body.length).toBeLessThan(largest.body.length);
  expect(gunzipSync(gzip.body).equals(largest.body), 'Decoded combined script bytes').toBe(true);
  const absent = await receive(deployment, cookie, largest.path);
  expect(absent.headers['content-encoding']).toBeUndefined();
  expect(absent.body.equals(largest.body), 'Identity combined script bytes').toBe(true);

  const entry = /src="\.\/(assets\/index-[A-Za-z0-9_-]{8}\.js)"/.exec(html)?.[1];
  if (entry === undefined) throw new Error('Missing hashed DSH entry script');
  const script = await receive(deployment, cookie, `/${entry}`, 'gzip');
  expect(script.headers['cache-control']).toBe(GATEWAY_IMMUTABLE);
  expectSessionVary(script.headers, entry);
  expect(script.body.length).toBeGreaterThan(0);
  expect(await firstEventFrame(deployment, cookie)).toMatchObject({ type: 'graph' });
}
