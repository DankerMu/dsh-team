// Mirrors the server heal's cookie forms (platform/src/auth/session-heal.ts); browser code
// cannot import backend source, so both sides assert the same cases in their unit tests.
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** Host-only, every Domain form of a DNS host and, for HTTPS, Secure/Partitioned variants. */
export function cookieForms(hostname: string, https: boolean): string[] {
  const forms = [''];
  if (!hostname.startsWith('[') && !IPV4.test(hostname)) {
    const labels = hostname.split('.');
    for (let index = 0; index < labels.length - 1; index++)
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
  const forms = cookieForms(hostname, protocol === 'https:');
  const names = window.document.cookie
    .split(';')
    .filter((pair) => pair.includes('='))
    .map((pair) => pair.slice(0, pair.indexOf('=')).trim());
  for (const name of names)
    for (const path of cookiePaths(pathname))
      for (const form of forms) window.document.cookie = `${name}=; Path=${path}${form}; Max-Age=0`;
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
