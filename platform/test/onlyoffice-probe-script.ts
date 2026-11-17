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
