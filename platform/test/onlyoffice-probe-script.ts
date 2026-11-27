/** JS source fragments shared by the ONLYOFFICE token and isolation fixtures' container scripts;
 * the embedder imports `node:crypto`/`node:http` and, for KEY_JS, has `hostname`, `file`, `info`, `secret`. */

/** dsh-sidebar-onlyoffice@0.2.0's document key input; k0 is the public algorithm, k1 the HMAC. */
export const KEY_JS = `const input = hostname() + '\\0' + file + '\\0' + String(info.size) + '\\0' + String(Math.round(info.mtimeMs));
const k0 = createHash('sha256').update(input).digest('hex');
const k1 = secret ? createHmac('sha256', secret).update(input).digest('hex') : undefined;`;

/** The released plugin's public file-token key; 18.1's patch signs with the per-instance secret. */
export const FILE_TOKEN_PUBLIC = 'dsh-sidebar-onlyoffice/file-token/v1';

export const MINT_JS = `const mint = (claims, key) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
};`;

/** An HS256 JWT under the embedder's `jwtSecret` binding, read at each call. */
export const JWT_JS = `const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims = {}) => { const signed = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 }); return signed + '.' + createHmac('sha256', jwtSecret).update(signed).digest('base64url'); };`;

/** A status-2 callback for `key` saving the embedder's `url`, with a body-`token` JWT when `signed`. */
export const CALLBACK_JS = `const callback = async (key, signed) => { const r = json(await exchange('POST', '/sidebar/onlyoffice/callback', { key, status: 2, url, ...(signed ? { token: jwt() } : {}) })); return { status: r.status, error: r.body?.error }; };`;

/** HTTP to `address`:`port` with Host `hostHeader`; `hold` > 0 keeps a stream open that long. */
export const exchangeJs = (address: string, hostHeader: string, port = 3080): string =>
  `const exchange = (method, path, body, hold = 0) => new Promise((resolve, reject) => {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers = { host: '${hostHeader}' };
  if (bytes !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
  const req = request({ host: ${JSON.stringify(address)}, port: ${String(port)}, method, path, headers }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('error', (error) => { if (hold === 0) reject(error); });
    const done = () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) });
    if (hold === 0) res.on('end', done);
    else setTimeout(() => { done(); req.destroy(); }, hold);
  });
  req.on('error', (error) => { if (!req.destroyed || hold === 0) reject(error); });
  req.end(bytes);
});`;

export const READ_JS = `const text = (response) => ({ status: response.status, body: response.body.toString('utf8') });
const json = (response) => {
  try { return { status: response.status, body: JSON.parse(response.body.toString('utf8')) }; }
  catch { return text(response); }
};`;

/**
 * #760 as uid1001 inside a running user image: `config` and `watch` with session-relative,
 * escaping, absolute, empty and missing paths under a fresh `/data/work` directory, removed after.
 * DSH answers at `address`, else at the container's own hostname address. Prints only statuses,
 * messages and whether each key and token-claim path equals the one derived from the absolute path.
 */
export const pathProbeScript = (address?: string): string => `
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { hostname } from 'node:os';
const secret = process.env.DSH_TEAM_ONLYOFFICE_FILE_SECRET;
const host = ${address === undefined ? '(await lookup(hostname(), 4)).address' : JSON.stringify(address)};
const dir = '/data/work/dsh-team-path-probe-' + randomBytes(6).toString('hex');
const file = dir + '/报告.docx';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (route, path, hold = 0) => new Promise((resolve, reject) => {
  const query = 'sessionId=t&cwd=' + encodeURIComponent(dir) + (path === undefined ? '' : '&path=' + encodeURIComponent(path));
  const req = request({ host, port: 3080, path: '/sidebar/onlyoffice/' + route + '?' + query, headers: { host: '127.0.0.1:3080' } }, (res) => {
    let body = '';
    res.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
    const done = () => resolve({ status: res.statusCode, type: res.headers['content-type'], body });
    if (hold === 0) res.on('end', done);
    else setTimeout(() => { done(); req.destroy(); }, hold);
  });
  req.on('error', reject).end();
});
const keyNow = () => { const info = statSync(file); ${KEY_JS} return k1; };
const refused = ({ status, body }) => { try { return { status, message: JSON.parse(body).error.message }; } catch { return { status, body: body.slice(0, 80) }; } };
const registered = async (key) => {
  for (const deadline = Date.now() + 3000; Date.now() < deadline; await pause(100))
    try { if (JSON.parse(readFileSync('/data/home/plugins/dsh-sidebar-onlyoffice/registry.json', 'utf8')).entries.some((entry) => entry.key === key)) return true; } catch {}
  return false;
};
const config = async (path) => {
  const response = await get('config', path);
  if (response.status !== 200) return refused(response);
  const { document } = JSON.parse(response.body).config;
  const token = new URL(document.url).searchParams.get('token').split('.')[0];
  const claim = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')).path;
  return { status: 200, key: document.key === keyNow(), claim: claim === file, registered: await registered(document.key) };
};
const stream = (response, key) => response.status !== 200 ? refused(response) : {
  status: 200, type: response.type, opened: response.body.startsWith('retry: 3000\\n\\n:ok\\n\\n'),
  changes: response.body.split('data: ').slice(1).map((event) => JSON.parse(event).key === key),
};
const refusals = (route) => [['escaping', '../x.docx'], ['outside', '/data/work/outside.docx'], ['empty', ''], ['missing', undefined]]
  .map(async ([name, path]) => [name, refused(await get(route, path))]);
const observed = {};
try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, 'dsh-team relative path probe');
  observed.config = Object.fromEntries([['relative', await config('报告.docx')], ['absolute', await config(file)], ...(await Promise.all(refusals('config')))]);
  const held = [get('watch', '报告.docx', 3000), get('watch', file, 3000)];
  await pause(1000);
  writeFileSync(file, 'dsh-team relative path probe, changed');
  const [relative, absolute] = await Promise.all(held);
  const key = keyNow();
  observed.watch = Object.fromEntries([['relative', stream(relative, key)], ['absolute', stream(absolute, key)], ...(await Promise.all(refusals('watch')))]);
} catch (error) {
  observed.error = error instanceof Error ? error.message : String(error);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(observed));
`;
