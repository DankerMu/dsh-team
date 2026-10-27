import type { FastifyInstance } from 'fastify';
import { sessionCookieShape } from './session-cookie.ts';

// Mirrors the browser clearing's cookie forms (platform/web/src/origin-state.ts); browser code
// cannot import backend source, so both sides assert the same cases in their unit tests.
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** Host-only, every Domain form of a DNS host and, for HTTPS, Secure/Partitioned variants. */
export function cookieForms(hostname: string, secure: boolean): string[] {
  const forms = [''];
  if (!hostname.startsWith('[') && !IPV4.test(hostname)) {
    const labels = hostname.split('.');
    for (let index = 0; index < labels.length - 1; index++)
      forms.push(`; Domain=${labels.slice(index).join('.')}`);
  }
  return secure
    ? forms.flatMap((form) => [form, `${form}; Secure`, `${form}; Partitioned; Secure`])
    : forms;
}

// The heal runs before authentication: its output must stay bounded and its input must not be
// able to inject cookie attributes. RFC 6265 path-value characters, without CTLs or ';'.
const MAX_PATH_LENGTH = 512;
const MAX_PATH_SEGMENTS = 16;
const COOKIE_PATH = /^\/[\x20-\x3a\x3c-\x7e]*$/;

/** The query-stripped request path, or null when it is not safe and small enough to heal. */
function healablePath(target: string): string | null {
  const path = target.split('?', 1)[0] ?? '';
  if (path.length > MAX_PATH_LENGTH || !COOKIE_PATH.test(path)) return null;
  return path.split('/').length - 1 > MAX_PATH_SEGMENTS ? null : path;
}

/** Every non-root cookie path that path-matches the request, with and without a trailing slash. */
export function shadowPaths(target: string): string[] {
  const path = healablePath(target);
  if (path === null) return [];
  const paths = new Set<string>();
  for (let index = 1; index < path.length; index++) {
    if (path[index] !== '/') continue;
    paths.add(path.slice(0, index));
    paths.add(path.slice(0, index + 1));
  }
  if (!path.endsWith('/')) {
    paths.add(path);
    paths.add(`${path}/`);
  }
  paths.delete('/');
  return [...paths];
}

const CREDENTIAL_ROUTES = new Set(['/_platform/api/login', '/_platform/api/register']);

/**
 * Expiries for shadowing platform_session cookies when the request carries more than one, or
 * any on login/registration: after a browser restart only a persistent planted one may remain.
 * A bare fragment is a nameless cookie and is also expired in nameless form, at the root too.
 * A named, unpartitioned host-only Path=/ expiry is never emitted: that is the real session.
 */
export function sessionHealCookies(
  cookieHeader: string | undefined,
  target: string,
  hostname: string,
  secure: boolean,
  credentialRequest = false,
): string[] {
  const { count, bare } = sessionCookieShape(cookieHeader);
  if (count < (credentialRequest ? 1 : 2) || healablePath(target) === null) return [];
  const forms = cookieForms(hostname, secure);
  const paths = shadowPaths(target);
  const roots = forms.filter((form) => form.startsWith('; Domain='));
  // A partitioned expiry cannot touch the unpartitioned session (unverified on a real TLS origin).
  if (secure) roots.push('; Partitioned; Secure');
  const expire = (prefix: string, at: string, form: string) =>
    `${prefix}; Path=${at}${form}; Max-Age=0`;
  const named = [
    ...paths.flatMap((at) => forms.map((form) => expire('platform_session=', at, form))),
    ...roots.map((form) => expire('platform_session=', '/', form)),
  ];
  if (!bare) return named;
  return [
    ...named,
    ...[...paths, '/'].flatMap((at) => forms.map((form) => expire('platform_session', at, form))),
  ];
}

/** Installs the heal on the root app; admission still reads the request as having no session. */
export function installSessionHeal(app: FastifyInstance, publicUrl: string, secure: boolean): void {
  const hostname = new URL(publicUrl).hostname;
  app.addHook('onRequest', (request, reply, done) => {
    const credential = CREDENTIAL_ROUTES.has(request.routeOptions.url ?? '');
    const cookies = sessionHealCookies(
      request.headers.cookie,
      request.url,
      hostname,
      secure,
      credential,
    );
    if (cookies.length !== 0) reply.header('set-cookie', cookies);
    done();
  });
}
