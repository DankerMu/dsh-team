import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertWebBuild, webRoutes } from './index.ts';

const HTML = '<!doctype html><html lang="zh-CN"><body>owned login entry</body></html>';
const SCRIPT = 'globalThis.ownedAsset = "local";';
const PRIVATE = 'outside-root-private-sentinel';

describe('declared platform static routes', () => {
  let directory = '';
  let root = '';
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-team-web-'));
    root = join(directory, 'dist');
    app = Fastify();
    await mkdir(join(root, 'assets', '.private'), { recursive: true });
    await writeFile(join(root, 'index.html'), HTML);
    await writeFile(join(root, 'assets', 'entry.js'), SCRIPT);
    await writeFile(join(root, 'assets', 'entry.css'), 'body { color: black; }');
    await writeFile(join(root, 'assets', '.env'), PRIVATE);
    await writeFile(join(root, 'assets', '.private', 'config.js'), PRIVATE);
    await writeFile(join(directory, 'private.js'), PRIVATE);
    await symlink(join(directory, 'private.js'), join(root, 'assets', 'escape.js'));
    await symlink(join(directory), join(root, 'assets', 'escape-directory'));
    await symlink(join(root, 'index.html'), join(root, 'assets', 'entry.html'));
    await symlink(join(root, 'assets', 'entry.js'), join(root, 'assets', 'local.js'));
    await app.register(webRoutes, { root });
  });

  afterEach(async () => {
    try {
      await app.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serves exact login HTML and local JavaScript and CSS with their MIME types', async () => {
    const login = await app.inject('/_platform/login');
    const script = await app.inject('/_platform/assets/entry.js?cache=1');
    const style = await app.inject('/_platform/assets/entry.css');

    expect(login.statusCode).toBe(200);
    expect(login.headers['content-type']).toContain('text/html');
    expect(login.body).toBe(HTML);
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toMatch(/(?:application|text)\/javascript/);
    expect(script.body).toBe(SCRIPT);
    expect(style.headers['content-type']).toContain('text/css');
    expect(style.body).toBe('body { color: black; }');
  });

  it('serves the same confined HTML at the exact registration page', async () => {
    const response = await app.inject('/_platform/register');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toBe(HTML);
  });

  it('serves the public account shell only at its declared exact page', async () => {
    const response = await app.inject('/_platform/account');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toBe(HTML);
  });

  it('serves HEAD metadata without a body and bounded byte ranges', async () => {
    const cases: [string, string][] = [
      ['/_platform/login', HTML],
      ['/_platform/register', HTML],
      ['/_platform/account', HTML],
      ['/_platform/assets/entry.js', SCRIPT],
    ];
    for (const [url, bytes] of cases) {
      const response = await app.inject({ method: 'HEAD', url });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('');
      expect(response.headers['content-length']).toBe(String(Buffer.byteLength(bytes)));
    }
    const range = await app.inject({
      url: '/_platform/assets/entry.js',
      headers: { range: 'bytes=0-9' },
    });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe('globalThis');
    expect(range.headers['content-range']).toBe(`bytes 0-9/${String(Buffer.byteLength(SCRIPT))}`);
  });

  it.each([
    '/_platform',
    '/_platform/',
    '/_platform/login/',
    '/_platform/wait',
    '/_platform/register/',
    '/_platform/account/',
    '/_platform/account/settings',
    '/_platform/account%00',
    '/_platform/account%2fsettings',
    '/_platform/admin',
    '/_platform/api/unknown',
    '/_platform/assets/missing.js',
    '/_platform/assets/',
    '/_platform/assets/.env',
    '/_platform/assets/%2eenv',
    '/_platform/assets/entry%00.js',
    '/_platform/assets/.private/config.js',
    '/_platform/assets/../index.html',
    '/_platform/assets/%2e%2e/index.html',
    '/_platform/assets/%2e%2e%2findex.html',
    '/_platform/assets/%252e%252e%252fprivate.js',
    '/_platform/assets/%2e%2e%5cprivate.js',
    '/_platform/assets/escape.js',
    '/_platform/assets/escape-directory/private.js',
    '/_platform/assets/entry.html',
  ])('rejects undeclared or escaping path %s without a page fallback', async (url) => {
    const response = await app.inject(url);

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).not.toContain(HTML);
    expect(response.body).not.toContain(PRIVATE);
  });

  it('allows an asset symlink only when its target stays inside the asset boundary', async () => {
    const response = await app.inject('/_platform/assets/local.js');

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(SCRIPT);
  });

  it.each(['/_platform/login', '/_platform/register', '/_platform/account'])(
    'does not expose a symlinked entry outside the build at %s',
    async (url) => {
      await rm(join(root, 'index.html'));
      await symlink(join(directory, 'private.js'), join(root, 'index.html'));

      const response = await app.inject(url);

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(PRIVATE);
      await expect(assertWebBuild(root)).rejects.toThrow('Platform web build');
    },
  );

  it('does not expose a symlinked assets directory outside the build', async () => {
    await rm(join(root, 'assets'), { recursive: true });
    await symlink(directory, join(root, 'assets'));

    const response = await app.inject('/_platform/assets/private.js');

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(PRIVATE);
    await expect(assertWebBuild(root)).rejects.toThrow('Platform web build');
  });

  it.each(['/_platform/login', '/_platform/register', '/_platform/account'])(
    'does not accept credential submissions at the static page %s',
    async (url) => {
      const response = await app.inject({ method: 'POST', url, payload: {} });

      expect(response.statusCode).toBe(404);
    },
  );

  it.each(['/_platform/login', '/_platform/register', '/_platform/account'])(
    'registers %s without a build but rejects that production prerequisite',
    async (url) => {
      const missingRoot = join(directory, 'not-built');
      const offline = Fastify();
      try {
        await offline.register(webRoutes, { root: missingRoot });
        const response = await offline.inject(url);

        expect(response.statusCode).toBe(404);
        await expect(assertWebBuild(missingRoot)).rejects.toThrow('run pnpm build:web');
      } finally {
        await offline.close();
      }
    },
  );

  it('rejects an incomplete or invalid build before production listening', async () => {
    await rm(join(root, 'index.html'));
    await expect(assertWebBuild(root)).rejects.toThrow('Platform web build');
    await mkdir(join(root, 'index.html'));
    await expect(assertWebBuild(root)).rejects.toThrow('Platform web build');
    await rm(join(root, 'index.html'), { recursive: true });
    await writeFile(join(root, 'index.html'), HTML);
    await rm(join(root, 'assets'), { recursive: true });
    await expect(assertWebBuild(root)).rejects.toThrow('Platform web build');
    await writeFile(join(root, 'assets'), 'not a directory');
    await expect(assertWebBuild(root)).rejects.toThrow('Platform web build');
  });

  it('accepts a readable complete build without changing its files', async () => {
    await assertWebBuild(root);

    const response = await app.inject('/_platform/login');
    expect(response.body).toBe(HTML);
  });
});
