import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { DatabaseHandle } from '../src/db/index.ts';

/** Real platform fixture: owned paths, explicit authority and captured production logger. */
export function buildCookieFixtureApp(
  root: string,
  database: DatabaseHandle,
  authority: string,
  write: (line: string) => void,
): Promise<FastifyInstance> {
  return buildApp(
    {
      host: '127.0.0.1',
      port: 0,
      logLevel: 'info',
      dataDir: root,
      managedConfigDir: join(root, 'managed'),
      dockerSocketPath: join(root, 'engine.sock'),
      userImage: 'dsh-team-user:local',
      seccompProfilePath: join(root, 'seccomp.json'),
      publicUrl: `http://${authority}`,
      authority,
      cookieSecure: false,
      trustedProxies: [],
    },
    database,
    { write },
  );
}

export function frame(stream: 1 | 2, text: string | Buffer): Buffer {
  const data = typeof text === 'string' ? Buffer.from(text) : text;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

export function reply(response: ServerResponse, cookie: string): void {
  response
    .writeHead(303, {
      'set-cookie': ['unrelated=value; Path=/', `${cookie}; Path=/; HttpOnly; SameSite=Strict`],
      location: './',
    })
    .end();
}
