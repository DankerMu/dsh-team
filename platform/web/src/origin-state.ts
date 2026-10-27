// Mirrors the server heal's cookie forms (platform/src/auth/session-heal.ts); browser code
// cannot import backend source, so both sides assert the same cases in their unit tests.
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Host-only, every Domain form of a DNS host and, for HTTPS, Secure/Partitioned variants.
 * Without `parents` only the exact hostname's Domain form is kept.
 */
export function cookieForms(hostname: string, https: boolean, parents = true): string[] {
  const forms = [''];
  if (!hostname.startsWith('[') && !IPV4.test(hostname)) {
    const labels = hostname.split('.');
    const domains = parents ? labels.length - 1 : Math.min(1, labels.length - 1);
    for (let index = 0; index < domains; index++)
      forms.push(`; Domain=${labels.slice(index).join('.')}`);
  }
  return https
    ? forms.flatMap((form) => [form, `${form}; Secure`, `${form}; Partitioned; Secure`])
    : forms;
}

/** Every cookie path visible at this page: the root, each ancestor and the page itself. */
export function cookiePaths(pathname: string): string[] {
  const paths = new Set(['/']);
  for (let index = 1; index < pathname.length; index++) {
    if (pathname[index] !== '/') continue;
    paths.add(pathname.slice(0, index));
    paths.add(pathname.slice(0, index + 1));
  }
  paths.add(pathname);
  return [...paths];
}

function expireCookies(): void {
  const { pathname, hostname, protocol } = window.location;
  const https = protocol === 'https:';
  const fragments = window.document.cookie
    .split(';')
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment !== '');
  for (const fragment of fragments) {
    const separator = fragment.indexOf('=');
    // A fragment without '=' is a nameless cookie; it is expired by writing it bare.
    const prefix = separator === -1 ? fragment : `${fragment.slice(0, separator).trim()}=`;
    // Other names keep their shared-parent-domain cookies, which other intranet systems may own.
    const session = separator === -1 || prefix === 'platform_session=';
    const forms = cookieForms(hostname, https, session);
    for (const path of cookiePaths(pathname))
      for (const form of forms)
        window.document.cookie = `${prefix}; Path=${path}${form}; Max-Age=0`;
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = window.indexedDB.deleteDatabase(name);
    // Blocked means another tab still holds it; the browser finishes once that tab closes.
    const settle = () => {
      resolve();
    };
    request.onsuccess = settle;
    request.onerror = settle;
    request.onblocked = settle;
  });
}

async function deleteDatabases(): Promise<void> {
  if (!('databases' in window.indexedDB)) return;
  const databases = await window.indexedDB.databases();
  await Promise.all(
    databases.map(({ name }) =>
      attempt(() => (name === undefined ? undefined : deleteDatabase(name))),
    ),
  );
}

async function unregisterWorkers(): Promise<void> {
  if (!('serviceWorker' in window.navigator)) return;
  const registrations = await window.navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => attempt(() => registration.unregister())));
}

async function deleteCaches(): Promise<void> {
  if (!('caches' in window)) return;
  const names = await window.caches.keys();
  await Promise.all(names.map((name) => attempt(() => window.caches.delete(name))));
}

async function attempt(step: () => unknown): Promise<void> {
  try {
    await step();
  } catch {
    // Best effort: the session change is committed and navigation must not depend on clearing.
  }
}

/** Clears what a previous platform session's pages could leave in this browser origin. */
export async function clearOriginState(): Promise<void> {
  await Promise.all([
    attempt(() => {
      window.localStorage.clear();
    }),
    attempt(() => {
      window.sessionStorage.clear();
    }),
    attempt(deleteDatabases),
    attempt(unregisterWorkers),
    attempt(deleteCaches),
    attempt(expireCookies),
  ]);
}
