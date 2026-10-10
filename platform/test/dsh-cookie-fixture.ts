import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { buildApp } from '../src/app.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import type { AcquireDshCookieInput, Orchestrator } from '../src/orchestrator/index.ts';
import { START_CONTAINER, START_MODEL, START_USER } from './container-start-fixture.ts';
import type { StartupRequest } from './container-start-fixture.ts';

export interface CookieAttempt {
  failed: boolean;
  serialized: string;
  result?: unknown;
}

export async function attemptCookieOperation(
  app: FastifyInstance,
  operation: Orchestrator['acquireDshCookie'],
  input: AcquireDshCookieInput,
): Promise<CookieAttempt> {
  try {
    return await operation(input).then((result: unknown) => {
      app.log.info({ result }, 'Acquisition returned');
      return { failed: false, serialized: JSON.stringify({ result }), result };
    });
  } catch (error) {
    app.log.error({ err: error }, 'Acquisition rejected');
    const serialized =
      error instanceof Error ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : '';
    return { failed: true, serialized };
  }
}

export function replyNetworkRequest(
  request: IncomingMessage,
  response: ServerResponse,
  daemon: { reply: (request: StartupRequest) => { status: number; document?: unknown } },
): void {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    // Only the real Docker client's serializer supplies this fixture request body.
    const body =
      chunks.length === 0
        ? {}
        : (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
    const result = daemon.reply({
      method: request.method ?? '',
      path: request.url ?? '',
      body,
    });
    response
      .writeHead(result.status)
      .end(result.document === undefined ? '' : JSON.stringify(result.document));
  });
}

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
      subnetPool: '172.30.0.0/16',
      upstreamMode: 'published-loopback',
      platformContainerName: 'dsh-team-platform',
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

/** The caller first proves real authenticated readiness; reuse must preserve that exact state. */
export async function assertRunningReuse(
  root: string,
  database: DatabaseHandle,
  startUserContainer: Orchestrator['startUserContainer'],
  authority: string,
  port: number,
): Promise<void> {
  const managedConfigDir = join(root, 'managed');
  await mkdir(managedConfigDir);
  const overlay = join(managedConfigDir, `${START_USER}.patch.yml`);
  await writeFile(overlay, 'unchanged managed overlay\n', { mode: 0o444 });
  const beforeRow = database.prepare('SELECT * FROM instances').get();
  const beforeAudit = database.prepare('SELECT * FROM audit_events').all();
  const beforeBytes = await readFile(overlay);
  const beforeInode = (await stat(overlay)).ino;

  expect(
    await startUserContainer({
      userId: START_USER,
      config: {
        userImage: 'dsh-team-user:local',
        seccompProfilePath: join(root, 'unavailable-seccomp.json'),
        managedConfigDir,
        authority,
        subnetPool: '172.30.0.0/16',
      },
      modelSettings: START_MODEL,
      modelKey: 'fixture-key',
    }),
  ).toEqual({
    outcome: 'running',
    containerId: START_CONTAINER,
    upstreamHost: '127.0.0.1',
    upstreamPort: port,
  });
  expect(database.prepare('SELECT * FROM instances').get()).toEqual(beforeRow);
  expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(beforeAudit);
  expect(await readFile(overlay)).toEqual(beforeBytes);
  expect((await stat(overlay)).ino).toBe(beforeInode);
  expect(database.prepare('SELECT status, last_error FROM instances').get()).toEqual({
    status: 'running',
    last_error: null,
  });
  expect(
    database
      .prepare('SELECT event_type, target, target_email, details FROM audit_events ORDER BY id')
      .all(),
  ).toEqual([
    {
      event_type: 'instance.ready',
      target: START_USER,
      target_email: 'cookie@example.test',
      details: '{}',
    },
  ]);
}

export function cookieState(database: DatabaseHandle) {
  return {
    instance: database.prepare('SELECT * FROM instances').all(),
    account: database.prepare('SELECT * FROM users').all(),
    audit: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
  };
}

export function launchFrames(token: string): Buffer[] {
  return [
    frame(1, 'ordinary boot output\ndsh web: http://127.0.0.1:3080/?to'),
    frame(2, `dsh web: http://127.0.0.1:3080/?token=${randomBytes(32).toString('base64url')}\n`),
    frame(1, `ken=${token.slice(0, 17)}`),
    frame(1, `${token.slice(17)}\n`),
  ];
}
