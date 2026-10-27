import type { FastifyInstance } from 'fastify';
import { sessionCookieShape } from './session-cookie.ts';

// Mirrors the browser clearing's cookie forms (platform/web/src/origin-state.ts); browser code
// cannot import backend source, so both sides assert the same cases in their unit tests.
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

const PARTITIONED = '; Partitioned; Secure';

/**
 * Host-only, the Domain forms of a DNS host (the hostname and each parent except the last label)
 * and, on HTTPS, each also as Partitioned; Secure. A plain Secure variant is unnecessary: from a
 * secure origin an expiry without Secure replaces a Secure cookie.
 */
export function cookieForms(hostname: string, secure: boolean): string[] {
  const forms = [''];
  if (!hostname.startsWith('[') && !IPV4.test(hostname)) {
    const labels = hostname.split('.');
    for (let index = 0; index < labels.length - 1; index++)
      forms.push(`; Domain=${labels.slice(index).join('.')}`);
  }
  return secure ? forms.flatMap((form) => [form, `${form}${PARTITIONED}`]) : forms;
}

// The heal runs before authentication: its output must stay bounded and its input must not be
// able to inject cookie attributes. RFC 6265 path-value characters, without CTLs or ';'.
const MAX_PATH_LENGTH = 256;
const MAX_PATH_SEGMENTS = 8;
const COOKIE_PATH = /^\/[\x20-\x3a\x3c-\x7e]*$/;

/** The query-stripped request path, or null when it is not safe and small enough to heal. */
function healablePath(target: string): string | null {
  const path = target.split('?', 1)[0] ?? '';
  if (path.length > MAX_PATH_LENGTH || !COOKIE_PATH.test(path)) return null;
  return path.split('/').length - 1 > MAX_PATH_SEGMENTS ? null : path;
}

/** Every non-root cookie path that path-matches the request, with and without a trailing slash, deepest first. */
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
  return [...paths].reverse();
}

const CREDENTIAL_ROUTES = new Set(['/_platform/api/login', '/_platform/api/register']);

// Behind a reverse proxy, nginx's default upstream header buffer is 4-8 KiB; stay well inside it.
const HEADER_BUDGET = 3072;

/**
 * Expiries for shadowing platform_session cookies when the request carries more than one, or
 * any on login/registration: after a browser restart only a persistent planted one may remain.
 * A bare fragment is a nameless cookie and is also expired in nameless form, at the root too.
 * Emitted in fixed priority order — named host-only (deepest first), nameless host-only, Domain
 * forms, then Partitioned variants — stopping before the values would exceed the budget.
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
  const paths = shadowPaths(target);
  const rooted = [...paths, '/'];
  const domains = cookieForms(hostname, false).slice(1);
  const named = (at: string, form: string) => `platform_session=; Path=${at}${form}; Max-Age=0`;
  const nameless = (at: string, form: string) => `platform_session; Path=${at}${form}; Max-Age=0`;
  const priority = (suffix: string) => [
    ...paths.map((at) => named(at, suffix)),
    ...(bare ? rooted.map((at) => nameless(at, suffix)) : []),
    ...rooted.flatMap((at) => domains.map((form) => named(at, `${form}${suffix}`))),
    ...(bare
      ? rooted.flatMap((at) => domains.map((form) => nameless(at, `${form}${suffix}`)))
      : []),
  ];
  const cookies: string[] = [];
  let total = 0;
  for (const cookie of [...priority(''), ...(secure ? priority(PARTITIONED) : [])]) {
    if (total + cookie.length > HEADER_BUDGET) break;
    cookies.push(cookie);
    total += cookie.length;
  }
  return cookies;
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
