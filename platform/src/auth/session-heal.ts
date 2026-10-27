import type { FastifyInstance } from 'fastify';
import { countSessionCookies } from './session-cookie.ts';

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

/** Every non-root cookie path that path-matches the request, with and without a trailing slash. */
export function shadowPaths(target: string): string[] {
  const path = target.split('?', 1)[0] ?? '';
  if (!path.startsWith('/')) return [];
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
 * A host-only Path=/ expiry is never emitted, so the legitimate HttpOnly session survives.
 */
export function sessionHealCookies(
  cookieHeader: string | undefined,
  target: string,
  hostname: string,
  secure: boolean,
  credentialRequest = false,
): string[] {
  const count = countSessionCookies(cookieHeader);
  if (count < (credentialRequest ? 1 : 2)) return [];
  const forms = cookieForms(hostname, secure);
  const expire = (path: string, form: string) =>
    `platform_session=; Path=${path}${form}; Max-Age=0`;
  return [
    ...shadowPaths(target).flatMap((path) => forms.map((form) => expire(path, form))),
    ...forms.filter((form) => form.startsWith('; Domain=')).map((form) => expire('/', form)),
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
