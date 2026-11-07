import { once } from 'node:events';
import type { IncomingHttpHeaders, RequestListener } from 'node:http';
import { connect } from 'node:net';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import type { GatewayUpstream } from '../src/gateway/index.ts';
import {
  cookieHeaders,
  injectRegister,
  readPublicIdentity,
  sessionCookieToken,
} from './auth-fixture.ts';
import { observeHttp, sendHttp, withForwardingApp, withUpstream } from './gateway-http-fixture.ts';

it('forwards malformed JSON bytes with only the selected DSH cookie and preserves upstream error bodies', async () => {
  const observed: unknown[] = [];
  await withUpstream(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        observed.push({
          method: request.method,
          path: request.url,
          host: request.headers.host,
          cookie: request.headers.cookie,
          body: Buffer.concat(chunks).toString(),
        });
        response.writeHead(401, {
          'content-type': 'application/json',
          'set-cookie': ['dsh-auth=hidden', 'another=hidden'],
          trailer: 'Set-Cookie',
        });
        response.addTrailers({ 'Set-Cookie': 'dsh-auth=trailer-hidden' });
        response.end('{"upstream":"selected","extra":42}');
      });
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ base, cookie, lines }) => {
          const response = await sendHttp(
            base,
            {
              method: 'POST',
              path: '/api/test?instance=forged',
              headers: { cookie: `theme=dark; ${cookie}`, 'content-type': 'application/json' },
            },
            '{',
          );

          expect(response.status).toBe(401);
          expect(response.body.toString()).toBe('{"upstream":"selected","extra":42}');
          expect(response.headers['set-cookie']).toBeUndefined();
          expect(response.trailers['set-cookie']).toBeUndefined();
          expect(observed).toEqual([
            {
              method: 'POST',
              path: '/api/test?instance=forged',
              host: '127.0.0.1:8080',
              cookie: target.cookie,
              body: '{',
            },
          ]);
          expect(lines.join('')).not.toContain('FST_ERR_REP_ALREADY_SENT');
        },
      );
    },
  );
});

it('binds two users to their own endpoint-cookie pair despite forged routing and hop headers', async () => {
  const observed: unknown[] = [];
  const handler =
    (label: string): RequestListener =>
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        observed.push({
          label,
          method: request.method,
          path: request.url,
          host: request.headers.host,
          cookie: request.headers.cookie,
          hop: request.headers['x-hop'],
          body: Buffer.concat(chunks),
        });
        response.writeHead(202, {
          'x-upstream': label,
          connection: 'x-private',
          'x-private': 'remove',
          'set-cookie': ['dsh-auth=private', 'another=private'],
        });
        response.end(label);
      });
    };
  await withUpstream(handler('A'), async (a) => {
    await withUpstream(handler('B'), async (b) => {
      const destinations = new Map<string, GatewayUpstream>();
      const selected: string[] = [];
      await withForwardingApp(
        (id) => {
          selected.push(id);
          return destinations.get(id) ?? { outcome: 'stopped' };
        },
        async ({ base, app, cookie, userId }) => {
          const registered = await injectRegister(app, {
            email: 'second@example.com',
            password: 'test-password',
          });
          const otherId = readPublicIdentity(registered.json<unknown>()).id;
          const otherCookie = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;
          destinations.set(userId, a);
          destinations.set(otherId, b);
          const body = Buffer.concat([Buffer.from([0, 255]), Buffer.from(otherId)]);
          const path = `/api/${otherId}/%2Fraw/../upload?user=${otherId}&instance=forged`;
          const forgedAuthority = `${b.host}:${String(b.port)}`;

          for (const [credential, label, id] of [
            [cookie, 'A', userId],
            [otherCookie, 'B', otherId],
          ] as const) {
            const response = await sendHttp(
              base,
              {
                method: 'POST',
                path: `http://${forgedAuthority}${path}`,
                headers: {
                  cookie: [credential, 'dsh-auth=forged', 'theme=dark'],
                  host: forgedAuthority,
                  'x-forwarded-host': forgedAuthority,
                  'x-user-id': otherId,
                  'content-type': 'application/octet-stream',
                  connection: 'Cookie, Host, X-Hop',
                  'x-hop': 'remove',
                },
              },
              body,
            );
            expect(response.status).toBe(202);
            expect(response.body.toString()).toBe(label);
            expect(response.headers['set-cookie']).toBeUndefined();
            expect(response.headers['x-private']).toBeUndefined();
            expect(response.headers['x-upstream']).toBe(label);
            expect(selected.at(-1)).toBe(id);
          }
          expect(observed).toEqual([
            {
              label: 'A',
              method: 'POST',
              path,
              host: '127.0.0.1:8080',
              cookie: a.cookie,
              hop: undefined,
              body,
            },
            {
              label: 'B',
              method: 'POST',
              path,
              host: '127.0.0.1:8080',
              cookie: b.cookie,
              hop: undefined,
              body,
            },
          ]);
          expect(selected).toEqual([userId, otherId]);
        },
      );
    });
  });
});

it('never resolves platform or anonymous traffic and preserves unavailable destinations', async () => {
  const selected: string[] = [];
  await withForwardingApp(
    (id) => {
      selected.push(id);
      return { outcome: 'stopped' };
    },
    async ({ base, cookie, userId, database }) => {
      expect((await sendHttp(base, { path: '/healthz', headers: { cookie } })).status).toBe(200);
      expect(
        (await sendHttp(base, { path: '/_platform/missing', headers: { cookie } })).status,
      ).toBe(404);
      expect((await sendHttp(base, { path: '/api/test' })).status).toBe(401);
      expect(selected).toEqual([]);
      expect((await sendHttp(base, { path: '/', headers: { cookie } })).status).toBe(503);
      expect(selected).toEqual([userId]);
      database.exec('DELETE FROM platform_sessions');
      expect((await sendHttp(base, { headers: { cookie } })).status).toBe(401);
      expect(selected).toEqual([userId]);
    },
  );
});

it.each(['resolver', 'endpoint', 'reset', 'upgrade'] as const)(
  'returns safe 502 for %s failure and remains usable',
  async (failure) => {
    let failing = true;
    const closed = Promise.withResolvers<undefined>();
    await withUpstream(
      (request, response) => {
        if (failing && failure === 'reset') {
          request.socket.destroy();
          return;
        }
        if (failing && failure === 'upgrade') {
          request.socket.once('close', () => {
            closed.resolve(undefined);
          });
          response.writeHead(101, { connection: 'Upgrade', upgrade: 'websocket' }).flushHeaders();
          return;
        }
        response.end('healthy');
      },
      async (target) => {
        await withForwardingApp(
          () => {
            if (failing && failure === 'resolver') throw new Error('private resolver diagnostic');
            return failing && failure === 'endpoint' ? { ...target, port: -1 } : target;
          },
          async ({ base, cookie, lines }) => {
            const response = await sendHttp(base, { headers: { cookie } });
            expect(response.status).toBe(502);
            expect(JSON.parse(response.body.toString()) as unknown).toEqual({
              statusCode: 502,
              error: 'Bad Gateway',
              message: 'Instance unavailable',
            });
            expect(`${response.body.toString()}${lines.join('')}`).not.toContain(
              'private resolver diagnostic',
            );
            expect(lines.join('')).not.toContain(target.cookie);
            if (failure === 'upgrade') await observeHttp(closed.promise);
            failing = false;
            expect((await sendHttp(base, { headers: { cookie } })).body.toString()).toBe('healthy');
          },
        );
      },
    );
  },
);

it('reports connection refusal without trying another destination and recovers on a later resolution', async () => {
  await withUpstream(
    (_request, response) => {
      response.end('unused');
    },
    async (retired, server) => {
      await withUpstream(
        (_request, response) => {
          response.end('healthy');
        },
        async (healthy) => {
          let selected = retired;
          await withForwardingApp(
            () => selected,
            async ({ base, cookie }) => {
              const closed = once(server, 'close');
              server.close();
              await closed;
              const response = await sendHttp(base, { headers: { cookie } });

              expect(response.status).toBe(502);
              expect(JSON.parse(response.body.toString()) as unknown).toMatchObject({
                statusCode: 502,
                error: 'Bad Gateway',
              });
              selected = healthy;
              expect((await sendHttp(base, { headers: { cookie } })).body.toString()).toBe(
                'healthy',
              );
            },
          );
        },
      );
    },
  );
});

const IMMUTABLE = 'private, max-age=31536000, immutable';

function withoutDate(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const rest = { ...headers };
  delete rest.date;
  return rest;
}

it('marks only a hashed DSH asset 200 immutable and forwards every other response unchanged', async () => {
  const encoded = gzipSync(Buffer.from('export const hashed = true;\n'.repeat(64)));
  await withUpstream(
    (request, response) => {
      const path = request.url ?? '';
      if (path === '/assets/missing-12345678.js') {
        response.writeHead(404, { 'content-type': 'text/plain', 'x-upstream': 'missing' });
        response.end('missing');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'content-encoding': 'gzip',
        vary: 'Accept-Encoding',
        'x-upstream': 'asset',
        ...(path === '/assets/kept-12345678.css' ? { 'cache-control': 'no-cache' } : {}),
      });
      response.end(request.method === 'HEAD' ? undefined : encoded);
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ base, cookie }) => {
          const get = (path: string, method = 'GET') =>
            sendHttp(base, { method, path, headers: { cookie, 'accept-encoding': 'gzip' } });
          const plain = await get('/assets/index.js');
          const hashed = await get('/assets/index-5SrrfWpU.js');
          const { 'cache-control': added, ...forwarded } = hashed.headers;

          expect(added).toBe(IMMUTABLE);
          expect(withoutDate(forwarded)).toEqual(withoutDate(plain.headers));
          expect(plain.headers['cache-control']).toBeUndefined();
          expect(plain.headers['content-encoding']).toBe('gzip');
          expect(plain.headers.vary).toBe('Accept-Encoding, Cookie');
          expect(hashed.body).toEqual(encoded);
          expect(plain.body).toEqual(encoded);
          const head = await get('/assets/index-5SrrfWpU.js', 'HEAD');
          expect(head.status).toBe(200);
          expect(head.headers['cache-control']).toBe(IMMUTABLE);
          expect(head.body).toHaveLength(0);
          const queried = await get('/assets/index-5SrrfWpU.js?x=1');
          expect(queried.headers['cache-control']).toBeUndefined();
          expect(queried.body).toEqual(encoded);
          const kept = await get('/assets/kept-12345678.css');
          expect(kept.headers['cache-control']).toBe('no-cache');
          expect(kept.body).toEqual(encoded);
          const missing = await get('/assets/missing-12345678.js');
          expect(missing.status).toBe(404);
          expect(missing.headers['cache-control']).toBeUndefined();
          expect(missing.headers['x-upstream']).toBe('missing');
          expect(missing.body.toString()).toBe('missing');
        },
      );
    },
  );
});

// The released better-sidebar 0.28.0 HTML preview policy (lib/index.js `/sidebar/html` route).
const HTML_PREVIEW_CSP =
  "sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'";

it('sandboxes every workspace file document and forwards the HTML preview and other responses unchanged', async () => {
  await withUpstream(
    (request, response) => {
      const path = request.url ?? '';
      if (path.startsWith('/sidebar/file?sessionId=s&path=/data/work/plain.html')) {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' });
        response.end('<script>self.origin</script>');
      } else if (path.startsWith('/sidebar/file?sessionId=s&path=/data/work/loose.html')) {
        response.writeHead(request.method === 'POST' ? 405 : 404, {
          'content-type': 'text/html',
          'content-security-policy': 'sandbox allow-scripts allow-same-origin',
          'x-content-type-options': 'sniff',
        });
        response.end('loose');
      } else if (path === '/sidebar/html/s/data/work/plain.html') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': HTML_PREVIEW_CSP,
          'x-content-type-options': 'nosniff',
        });
        response.end('preview');
      } else {
        response.writeHead(200, { 'content-type': 'text/html', vary: 'Accept-Encoding' });
        response.end('other');
      }
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ base, cookie }) => {
          const get = (path: string, method = 'GET') =>
            sendHttp(base, { method, path, headers: { cookie } });

          const plain = await get('/sidebar/file?sessionId=s&path=/data/work/plain.html');
          const missing = await get('/sidebar/file?sessionId=s&path=/data/work/loose.html');
          const posted = await get('/sidebar/file?sessionId=s&path=/data/work/loose.html', 'POST');
          const preview = await get('/sidebar/html/s/data/work/plain.html');
          const files = await get('/sidebar/files?sessionId=s&path=/data/work/plain.html');
          const other = await get('/api/session/list');

          expect(plain.status).toBe(200);
          expect(plain.body.toString()).toBe('<script>self.origin</script>');
          expect(plain.headers['content-type']).toBe('text/html');
          expect(plain.headers['cache-control']).toBe('no-cache');
          expect(plain.headers.vary).toBe('Cookie');
          for (const [response, status] of [
            [plain, 200],
            [missing, 404],
            [posted, 405],
          ] as const) {
            expect(response.status).toBe(status);
            expect(response.headers['content-security-policy']).toBe('sandbox');
            expect(response.headers['x-content-type-options']).toBe('nosniff');
          }
          expect(missing.body.toString()).toBe('loose');
          expect(preview.headers['content-security-policy']).toBe(HTML_PREVIEW_CSP);
          expect(preview.headers['x-content-type-options']).toBe('nosniff');
          expect(preview.body.toString()).toBe('preview');
          for (const response of [files, other]) {
            expect(response.status).toBe(200);
            expect(response.headers['content-security-policy']).toBeUndefined();
            expect(response.headers['x-content-type-options']).toBeUndefined();
            expect(response.headers.vary).toBe('Accept-Encoding, Cookie');
            expect(response.body.toString()).toBe('other');
          }
        },
      );
    },
  );
});

/** The released DSH 0.2.1-rc.2 router expression, applied by the stub to the target it received. */
function dshRoutesWorkspaceFile(url: string): boolean {
  const pathname = new URL(url, 'http://x').pathname;
  return pathname === '/sidebar/file' || pathname.startsWith('/sidebar/file/');
}

/** One raw HTTP/1.1 exchange, so the gateway receives exactly the given request target. */
async function rawExchange(base: string, cookie: string, target: string) {
  const address = new URL(base);
  const socket = connect(Number(address.port), address.hostname);
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  const closed = once(socket, 'close');
  try {
    await once(socket, 'connect');
    socket.write(
      `GET ${target} HTTP/1.1\r\nHost: ${address.host}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`,
    );
    await observeHttp(closed);
  } finally {
    socket.destroy();
  }
  const raw = Buffer.concat(chunks).toString('latin1');
  const [head = '', ...body] = raw.split('\r\n\r\n');
  const headers = new Map<string, string>();
  for (const line of head.split('\r\n').slice(1)) {
    const at = line.indexOf(':');
    headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return { status: head.split(' ', 2)[1], headers, body: body.join('\r\n\r\n') };
}

it('adds the sandbox exactly when DSH would route the forwarded target to the workspace file route', async () => {
  const targets = [
    ['/sidebar/file?sessionId=s&path=x.html', true],
    ['/sidebar/x/../file?sessionId=s&path=x.html', true],
    ['/sidebar\\file?sessionId=s&path=x.html', true],
    ['/sidebar/files?sessionId=s&path=x.html', false],
    ['/sidebar//file?sessionId=s&path=x.html', false],
    ['//x/sidebar/file?sessionId=s&path=x.html', true],
    ['//x/sidebar/html/s/x.html', false],
    ['http://h/sidebar/file?sessionId=s&path=x.html', true],
    ['http://h//x/sidebar/file?sessionId=s&path=x.html', true],
    ['http://h/sidebar/filex?sessionId=s&path=x.html', false],
  ] as const;
  const observed: string[] = [];
  await withUpstream(
    (request, response) => {
      const url = request.url ?? '/';
      observed.push(url);
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(dshRoutesWorkspaceFile(url) ? 'stub-hit' : 'stub-miss');
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ base, cookie }) => {
          for (const [requestTarget, expected] of targets) {
            const response = await rawExchange(base, cookie, requestTarget);

            expect(response.status).toBe('200');
            const hit = response.body.includes('stub-hit');
            expect(hit || response.body.includes('stub-miss')).toBe(true);
            expect(hit).toBe(expected);
            expect(response.headers.get('content-security-policy')).toBe(
              hit ? 'sandbox' : undefined,
            );
            expect(response.headers.get('x-content-type-options')).toBe(
              hit ? 'nosniff' : undefined,
            );
          }
          expect(observed).toHaveLength(targets.length);
        },
      );
    },
  );
});
