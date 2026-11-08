import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { writeManagedConfig } from '../src/managed-config/index.ts';
import { record } from './docker-cleanup.ts';
import { lifecycleWebNetwork } from './managed-policy-fixture.ts';
import { rejectPluginFailures } from './plugin-failure-markers.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { execWebScript, runWebStartup, webAddress } from './web-startup-fixture.ts';
import type { WebContainer, WebNetwork } from './web-startup-fixture.ts';

const SECRET_ENV = 'DSH_TEAM_ONLYOFFICE_FILE_SECRET';
// dsh-app-boot 0.2.1 installFailLoud labels: an unhandled rejection or exception ends dsh web.
const FATAL_MARKERS = ['fatal load failure', 'fatal uncaught exception'];

type Phase = 'absent' | 'present';

/**
 * Runs inside the instance as uid1001. DSH binds only the overlay's address, so requests go there
 * with a loopback Host (the plugin's trust fence reads only Host and Origin). The secret is read
 * from the container environment, never from this text; only its SHA-256 prefix leaves.
 */
function probeScript(address: string, phase: Phase): string {
  return `
import { createHash, createHmac } from 'node:crypto';
import { createServer, request } from 'node:http';
import { hostname } from 'node:os';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
const phase = ${JSON.stringify(phase)};
const secret = process.env.${SECRET_ENV};
const PUBLIC = 'dsh-sidebar-onlyoffice/file-token/v1';
const dir = '/data/work/onlyoffice-' + phase;
const file = dir + '/probe.docx';
const original = Buffer.from('dsh-team onlyoffice token probe ' + phase);
const saved = Buffer.from('dsh-team onlyoffice saved bytes ' + phase);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(dir, { recursive: true });
writeFileSync(file, original);
const info = statSync(file);
const input = hostname() + '\\0' + file + '\\0' + String(info.size) + '\\0' + String(Math.round(info.mtimeMs));
const k0 = createHash('sha256').update(input).digest('hex');
const k1 = secret ? createHmac('sha256', secret).update(input).digest('hex') : undefined;
const mint = (claims, key) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
};
const exchange = (method, path, body, hold = 0) => new Promise((resolve, reject) => {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers = { host: '127.0.0.1:3080' };
  if (bytes !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
  const req = request({ host: ${JSON.stringify(address)}, port: 3080, method, path, headers }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('error', (error) => { if (hold === 0) reject(error); });
    const done = () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) });
    if (hold === 0) res.on('end', done);
    else setTimeout(() => { done(); req.destroy(); }, hold);
  });
  req.on('error', (error) => { if (!req.destroyed || hold === 0) reject(error); });
  req.end(bytes);
});
const text = (response) => ({ status: response.status, body: response.body.toString('utf8') });
const json = (response) => {
  try { return { status: response.status, body: JSON.parse(response.body.toString('utf8')) }; }
  catch { return text(response); }
};
const query = 'sessionId=t&path=' + encodeURIComponent(file) + '&cwd=' + encodeURIComponent(dir);
const claims = (key) => ({ key, path: file, cwd: dir, exp: Math.floor(Date.now() / 1000) + 600 });
const fileWith = async (token) => text(await exchange('GET', '/sidebar/onlyoffice/file?token=' + encodeURIComponent(token)));
const registry = () => {
  try {
    const entries = JSON.parse(readFileSync('/data/home/plugins/dsh-sidebar-onlyoffice/registry.json', 'utf8')).entries;
    return { entries: entries.length, k0: entries.some((entry) => entry.key === k0), k1: entries.some((entry) => entry.key === k1) };
  } catch (error) {
    return { entries: 0, k0: false, k1: false, file: error.code ?? 'unreadable' };
  }
};
let downloads = 0;
const server = createServer((req, res) => { downloads += 1; res.writeHead(200, { 'content-length': String(saved.length) }); res.end(saved); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const savedUrl = 'http://127.0.0.1:' + String(server.address().port) + '/saved';
const callback = async (key) => {
  const before = downloads;
  const response = json(await exchange('POST', '/sidebar/onlyoffice/callback', { key, status: 2, url: savedUrl }));
  const bytes = readFileSync(file);
  return { ...response, downloads: downloads - before, file: bytes.equals(original) ? 'unchanged' : bytes.equals(saved) ? 'saved' : 'other' };
};
const observed = { phase, secret: secret === undefined ? null : createHash('sha256').update(secret).digest('hex').slice(0, 16) };
// Any probe error is reported in the observation, so the host diff shows the failed step.
try {
observed.liveness = text(await exchange('GET', '/sidebar/onlyoffice/file'));
const config = json(await exchange('GET', '/sidebar/onlyoffice/config?' + query));
observed.config = { status: config.status, code: config.body?.error?.code, message: config.status === 500 ? config.body?.error?.message : undefined };
if (k1 !== undefined) {
  const deadline = Date.now() + 5000;
  while (!registry().k1 && Date.now() < deadline) await pause(100);
  const token = await fileWith(mint(claims(k1), secret));
  observed.secretToken = { status: token.status, matches: token.body === original.toString('utf8') };
} else await pause(1500);
observed.registry = registry();
observed.publicToken = await fileWith(mint(claims(k1 ?? k0), PUBLIC));
observed.emptyToken = await fileWith(mint(claims(k1 ?? k0), ''));
observed.callbackK0 = await callback(k0);
if (k1 !== undefined) observed.callbackK1 = await callback(k1);
else {
  const watch = await exchange('GET', '/sidebar/onlyoffice/watch?' + query, undefined, 1500);
  const stream = watch.body.toString('utf8');
  observed.watch = { status: watch.status, type: watch.type, opened: stream.includes(':ok'), events: stream.split('data:').length - 1 };
  await pause(1000);
  observed.afterWatch = text(await exchange('GET', '/sidebar/onlyoffice/file'));
}
} catch (error) {
  observed.error = error instanceof Error ? error.message : String(error);
}
server.close();
process.stdout.write(JSON.stringify(observed));
`;
}

const MISSING_TOKEN = { status: 400, body: 'missing token' };
const REJECTED_TOKEN = { status: 403, body: 'invalid token: bad-signature' };
const UNREGISTERED = { status: 200, body: { error: 1 }, downloads: 0, file: 'unchanged' };

/** The governing invariant per start: only this start's secret mints, verifies and registers. */
function expectedObservation(phase: Phase, secretPrefix: string | null): Record<string, unknown> {
  const common = {
    phase,
    secret: secretPrefix,
    liveness: MISSING_TOKEN,
    publicToken: REJECTED_TOKEN,
    emptyToken: REJECTED_TOKEN,
    callbackK0: UNREGISTERED,
  };
  if (phase === 'absent')
    return {
      ...common,
      // documentKey throws before registry.set: no key is derived or registered.
      config: {
        status: 500,
        code: 'internal',
        message: 'onlyoffice: file token secret unavailable',
      },
      registry: { entries: 0, k0: false, k1: false, file: 'ENOENT' },
      watch: { status: 200, type: 'text/event-stream; charset=utf-8', opened: true, events: 0 },
      afterWatch: MISSING_TOKEN,
    };
  return {
    ...common,
    // Registered before the Document Server checks; 18.1 writes no Office configuration.
    config: { status: 503, code: 'config-error' },
    secretToken: { status: 200, matches: true },
    registry: { entries: 1, k0: false, k1: true },
    callbackK1: { status: 200, body: { error: 0 }, downloads: 1, file: 'saved' },
  };
}

function docker(lifecycle: UserImageLifecycle, args: string[]) {
  const result = lifecycle.command(args, 30_000);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error(`ONLYOFFICE probe docker ${args[0] ?? ''} failed`);
  return result;
}

/** Plugin-relevant log lines only; launch tokens and the secret never leave this scope. */
function diagnosticLines(lifecycle: UserImageLifecycle, container: string, secret: string) {
  const logs = lifecycle.command(['logs', '--tail', '200', container], 30_000);
  const state = lifecycle.command(
    ['container', 'inspect', '--format', '{{.State.Status}} exit={{.State.ExitCode}}', container],
    30_000,
  );
  const lines = `${logs.stdout}\n${logs.stderr}`
    .split(/\r?\n/)
    .filter((line) => /onlyoffice|fatal|plugin/i.test(line))
    .map((line) =>
      line.replaceAll(secret, '<secret>').replace(/token=[^\s&]+/g, 'token=<redacted>'),
    );
  return `state=${state.stdout.trim()}\n${lines.slice(-40).join('\n')}`;
}

function webContainer(
  lifecycle: UserImageLifecycle,
  phase: Phase,
  overlay: string,
  network: WebNetwork,
  secret: string,
): WebContainer {
  const container = `dsh-team-test-${lifecycle.runId}-onlyoffice-${phase}`;
  lifecycle.registerContainer(container);
  return {
    container,
    imageId: lifecycle.imageId,
    runId: lifecycle.runId,
    stateVolume: lifecycle.stateVolume,
    workVolume: lifecycle.workVolume,
    overlay,
    seccomp: lifecycle.seccomp,
    network,
    ...(phase === 'present' ? { env: { [SECRET_ENV]: secret } } : {}),
  };
}

/** One start: the probe, a second liveness read, then fatal and plugin-failure markers; any
 * failure carries the container state and its redacted plugin log lines. */
async function probeStart(
  lifecycle: UserImageLifecycle,
  expected: WebContainer,
  phase: Phase,
  secret: string,
): Promise<Record<string, unknown>> {
  try {
    await runWebStartup(lifecycle.command, expected);
    const observed = record(
      JSON.parse(
        execWebScript(
          lifecycle.command,
          expected,
          probeScript(webAddress(expected.network), phase),
        ),
      ),
    );
    const prefix = phase === 'present' ? createHash('sha256').update(secret).digest('hex') : null;
    const wanted = expectedObservation(phase, prefix?.slice(0, 16) ?? null);
    if (!isDeepStrictEqual(observed, wanted))
      throw new Error(
        `ONLYOFFICE ${phase}-secret start differs:\nobserved=${JSON.stringify(observed)}\n` +
          `expected=${JSON.stringify(wanted)}`,
      );
    // execWebScript requires a running instance before and after: the process survived.
    const later = execWebScript(
      lifecycle.command,
      expected,
      "import { request } from 'node:http';" +
        `request({ host: ${JSON.stringify(webAddress(expected.network))}, port: 3080, path: '/sidebar/onlyoffice/file', headers: { host: '127.0.0.1:3080' } }, ` +
        "(res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => process.stdout.write(JSON.stringify({ status: res.statusCode, body }))); }).end();",
    );
    if (!isDeepStrictEqual(JSON.parse(later), MISSING_TOKEN))
      throw new Error(`ONLYOFFICE ${phase}-secret liveness differs: ${later}`);
    const logs = docker(lifecycle, ['logs', expected.container]);
    for (const marker of FATAL_MARKERS)
      if (logs.stdout.includes(marker) || logs.stderr.includes(marker))
        throw new Error(`ONLYOFFICE ${phase}-secret start logged ${marker}`);
    rejectPluginFailures(logs, `ONLYOFFICE ${phase}-secret start plugin load failed`);
    return observed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\n${diagnosticLines(lifecycle, expected.container, secret)}`.replaceAll(
        secret,
        '<secret>',
      ),
      { cause: error },
    );
  }
}

/**
 * 18.1: the patched dsh-sidebar-onlyoffice derives file tokens and document keys only from the
 * per-start DSH_TEAM_ONLYOFFICE_FILE_SECRET. A start without it mints, verifies and registers
 * nothing and survives a watch; a start with a test-owned secret serves only its own tokens and
 * registers only its own key. The no-secret start runs first: the registry persists on the volume.
 */
export async function runOnlyofficeTokenScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const secret = randomBytes(32).toString('hex');
  const network = lifecycleWebNetwork(lifecycle, 'onlyoffice');
  const overlay = await writeManagedConfig(
    lifecycle.overlayDirectory,
    'onlyofficetk',
    `- id: webserver\n  config:\n    host: ${webAddress(network)}\n    port: 3080\n`,
  );
  const absent = webContainer(lifecycle, 'absent', overlay, network, secret);
  const withoutSecret = await probeStart(lifecycle, absent, 'absent', secret);
  docker(lifecycle, ['stop', absent.container]);
  docker(lifecycle, ['rm', absent.container]);
  const present = webContainer(lifecycle, 'present', overlay, network, secret);
  const withSecret = await probeStart(lifecycle, present, 'present', secret);
  return JSON.stringify({ absent: withoutSecret, present: withSecret });
}
