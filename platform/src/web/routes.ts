import fastifyStatic from '@fastify/static';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';

// src/web and dist/web have the same depth relative to the browser workspace.
const WEB_ROOT = fileURLToPath(new URL('../../web/dist/', import.meta.url));

interface WebOptions {
  root?: string;
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function confinedFile(root: string, file: string): Promise<boolean> {
  // Fastify has decoded route parameters; do not decode them a second time.
  if (file.includes('\\') || file.includes('\0') || /(?:^|\/)\./u.test(file)) return false;
  try {
    const canonicalRoot = await realpath(root);
    const canonicalFile = await realpath(join(root, file));
    // Asset symlinks may not expose other build files, either.
    const boundary = file.startsWith('assets/') ? join(canonicalRoot, 'assets') : canonicalRoot;
    return contained(boundary, canonicalFile) && (await stat(canonicalFile)).isFile();
  } catch {
    // Missing, unreadable and broken-link paths are not public files.
    return false;
  }
}

/** Production prerequisite; registration remains independent of generated artifacts. */
export async function assertWebBuild(root = WEB_ROOT): Promise<void> {
  try {
    if (!(await confinedFile(root, 'index.html'))) throw new Error('Invalid web entry');
    const entry = join(root, 'index.html');
    const assets = join(root, 'assets');
    if (!(await stat(assets)).isDirectory()) throw new Error('Invalid web build');
    await access(entry, constants.R_OK);
    await access(assets, constants.R_OK | constants.X_OK);
    // An asset-directory symlink outside the build is not a valid production build.
    if (!contained(await realpath(root), await realpath(assets))) throw new Error('Invalid assets');
  } catch {
    throw new Error(
      'Platform web build is missing or unreadable; run pnpm build:web before starting',
    );
  }
}

export const webRoutes: FastifyPluginAsync<WebOptions> = async (app, { root = WEB_ROOT }) => {
  // Use the library for streams, MIME, ranges and HEAD, but never its broad wildcard.
  // serve:false without root avoids filesystem prerequisites in offline app/contract construction.
  await app.register(fastifyStatic, { serve: false, dotfiles: 'ignore', index: false });
  for (const url of ['/_platform/login', '/_platform/register']) {
    app.route({
      method: ['GET', 'HEAD'],
      url,
      schema: { hide: true, response: { 200: { type: 'string' } } },
      handler: async (_request, reply) => {
        if (!(await confinedFile(root, 'index.html'))) {
          reply.callNotFound();
          return reply;
        }
        return reply.sendFile('index.html', root);
      },
    });
  }
  app.route<{ Params: { '*': string } }>({
    method: ['GET', 'HEAD'],
    url: '/_platform/assets/*',
    schema: { hide: true, response: { 200: { type: 'string' }, 206: { type: 'string' } } },
    handler: async (request, reply) => {
      const file = `assets/${request.params['*']}`;
      if (!(await confinedFile(root, file))) {
        reply.callNotFound();
        return reply;
      }
      return reply.sendFile(file, root);
    },
  });
};
