import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildApp } from '../src/app.ts';
import { applyMigrations, openDatabase, type DatabaseHandle } from '../src/db/index.ts';

const CENSOR = '[redacted]';
const PROBE_PATH = '/log-redaction-probe';
const INFO_MESSAGE = 'structured credential snapshot';
const ERROR_MESSAGE = 'structured credential snapshot failed';
const INCOMING_MESSAGE = 'incoming request';
const COMPLETED_MESSAGE = 'request completed';

const REQUEST_AUTHORIZATION = 'req-authorization-marker-7f3a';
const REQUEST_COOKIE = 'req-cookie-marker-9c21';
const REQUEST_SET_COOKIE = 'req-set-cookie-marker-4b88';
const RESPONSE_AUTHORIZATION = 'res-authorization-marker-e12d';
const RESPONSE_COOKIE = 'res-cookie-marker-a77c';
const RESPONSE_SET_COOKIE_A = 'res-set-cookie-a-marker-55d0';
const RESPONSE_SET_COOKIE_B = 'res-set-cookie-b-marker-61fe';
const BODY_PASSWORD = 'body-password-marker-c0de';
const BODY_CURRENT_PASSWORD = 'body-current-password-marker-31ae';
const BODY_NEW_PASSWORD = 'body-new-password-marker-62fd';
const REQUEST_PROBE = 'safe-request-probe';
const BODY_EMAIL = 'safe-body-email@example.com';
const RESPONSE_TRACE = 'safe-response-trace';

const SECRET_MARKERS = [
  REQUEST_AUTHORIZATION,
  REQUEST_COOKIE,
  REQUEST_SET_COOKIE,
  RESPONSE_AUTHORIZATION,
  RESPONSE_COOKIE,
  RESPONSE_SET_COOKIE_A,
  RESPONSE_SET_COOKIE_B,
  BODY_PASSWORD,
  BODY_CURRENT_PASSWORD,
  BODY_NEW_PASSWORD,
] as const;

const RESPONSE_SET_COOKIES = [RESPONSE_SET_COOKIE_A, RESPONSE_SET_COOKIE_B] as const;

const PROBE_BODY = JSON.stringify({
  password: BODY_PASSWORD,
  currentPassword: BODY_CURRENT_PASSWORD,
  newPassword: BODY_NEW_PASSWORD,
  email: BODY_EMAIL,
});

const PROBE_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: { status: { type: 'string', enum: ['ok'] } },
} as const;

const INFO_CONFIG = {
  host: '127.0.0.1',
  port: 0,
  logLevel: 'info',
  dataDir: './data',
  managedConfigDir: './data/managed-config',
  dockerSocketPath: '/var/run/docker.sock',
  userImage: 'dsh-team-user:local',
  seccompProfilePath: '/unused/seccomp.json',
  publicUrl: 'http://127.0.0.1',
  authority: '127.0.0.1',
  cookieSecure: false,
  trustedProxies: [],
} as const;

const CREDENTIAL_SERIALIZERS = {
  req: (request: FastifyRequest) => ({ headers: request.headers, body: request.body }),
  res: (reply: FastifyReply) => ({
    headers: reply.getHeaders(),
    statusCode: reply.statusCode,
  }),
};

interface ObservedRequest {
  authorization: string | string[] | undefined;
  cookie: string | string[] | undefined;
  setCookie: string | string[] | undefined;
  probe: string | string[] | undefined;
  body: unknown;
}

interface ProbeHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface ObservedReplyHeaders {
  authorization: number | string | string[] | undefined;
  cookie: number | string | string[] | undefined;
  'set-cookie': number | string | string[] | undefined;
  'x-trace': number | string | string[] | undefined;
}

interface ProbeObservation {
  request?: ObservedRequest;
  replyHeaders?: ObservedReplyHeaders;
}

function logObjectAt(value: unknown, key: string): Record<string, unknown> {
  // Pino JSON lines nest objects under known keys after serializers run.
  const object = value as Record<string, unknown>;
  return object[key] as Record<string, unknown>;
}

function logWithMessage(
  entries: readonly Record<string, unknown>[],
  message: string,
): Record<string, unknown> {
  for (const entry of entries) {
    if (entry.msg === message) {
      return entry;
    }
  }
  throw new Error(`missing log message: ${message}`);
}

function assertCensoredSnapshot(entry: Record<string, unknown>): void {
  const req = logObjectAt(entry, 'req');
  const reqHeaders = logObjectAt(req, 'headers');
  const reqBody = logObjectAt(req, 'body');
  const res = logObjectAt(entry, 'res');
  const resHeaders = logObjectAt(res, 'headers');

  expect(reqHeaders.authorization).toBe(CENSOR);
  expect(reqHeaders.cookie).toBe(CENSOR);
  expect(reqHeaders['set-cookie']).toBe(CENSOR);
  expect(reqBody.password).toBe(CENSOR);
  expect(reqBody.currentPassword).toBe(CENSOR);
  expect(reqBody.newPassword).toBe(CENSOR);
  expect(logObjectAt(entry, 'credentials')).toEqual({
    currentPassword: CENSOR,
    newPassword: CENSOR,
    label: 'safe-credential-label',
  });
  expect(reqBody.email).toBe(BODY_EMAIL);
  expect(reqHeaders['x-probe']).toBe(REQUEST_PROBE);
  expect(resHeaders.authorization).toBe(CENSOR);
  expect(resHeaders.cookie).toBe(CENSOR);
  expect(resHeaders['set-cookie']).toBe(CENSOR);
  expect(resHeaders['x-trace']).toBe(RESPONSE_TRACE);
  expect(res.statusCode).toBe(200);
}

function assertAutomaticMetadata(
  incoming: Record<string, unknown>,
  completed: Record<string, unknown>,
  requestId: unknown,
): void {
  const req = logObjectAt(incoming, 'req');
  const res = logObjectAt(completed, 'res');

  expect(incoming.reqId).toBe(requestId);
  expect(completed.reqId).toBe(requestId);
  expect(req.method).toBe('POST');
  expect(req.url).toBe(PROBE_PATH);
  expect(req).not.toHaveProperty('headers');
  expect(req).not.toHaveProperty('body');
  expect(res.statusCode).toBe(200);
  expect(res).not.toHaveProperty('headers');
}

async function closeOwned(
  app: FastifyInstance | undefined,
  database: DatabaseHandle,
): Promise<void> {
  if (app === undefined) {
    database.close();
    return;
  }
  try {
    await app.close();
  } catch (error) {
    if (database.open) {
      database.close();
    }
    throw error;
  }
}

function postProbe(url: URL): Promise<ProbeHttpResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<ProbeHttpResponse>();
  const req = httpRequest(
    url,
    {
      method: 'POST',
      headers: {
        authorization: REQUEST_AUTHORIZATION,
        cookie: REQUEST_COOKIE,
        'set-cookie': REQUEST_SET_COOKIE,
        'x-probe': REQUEST_PROBE,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(PROBE_BODY)),
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    },
  );
  req.on('error', reject);
  req.write(PROBE_BODY);
  req.end();
  return promise;
}

function registerProbeRoute(app: FastifyInstance, observed: ProbeObservation): void {
  app.post(
    PROBE_PATH,
    { schema: { response: { 200: PROBE_RESPONSE_SCHEMA } } },
    (request, reply) => {
      reply.header('authorization', RESPONSE_AUTHORIZATION);
      reply.header('cookie', RESPONSE_COOKIE);
      reply.header('set-cookie', [...RESPONSE_SET_COOKIES]);
      reply.header('x-trace', RESPONSE_TRACE);

      const child = request.log.child({}, { serializers: CREDENTIAL_SERIALIZERS });
      const credentials = {
        currentPassword: BODY_CURRENT_PASSWORD,
        newPassword: BODY_NEW_PASSWORD,
        label: 'safe-credential-label',
      };
      child.info({ req: request, res: reply, credentials }, INFO_MESSAGE);
      child.error({ req: request, res: reply, credentials }, ERROR_MESSAGE);

      observed.request = {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        setCookie: request.headers['set-cookie'],
        probe: request.headers['x-probe'],
        body: request.body,
      };
      const replyHeaders = reply.getHeaders();
      observed.replyHeaders = {
        authorization: replyHeaders.authorization,
        cookie: replyHeaders.cookie,
        'set-cookie': replyHeaders['set-cookie'],
        'x-trace': replyHeaders['x-trace'],
      };
      return { status: 'ok' as const };
    },
  );
}

describe('HTTP structured log redaction over a real TCP port', () => {
  it('censors credential fields in child-serialized logs without changing HTTP values', async () => {
    const lines: string[] = [];
    const observed: ProbeObservation = {};
    const database = openDatabase(':memory:');
    let app: FastifyInstance | undefined;
    let httpResponse: ProbeHttpResponse;

    try {
      applyMigrations(database);
      app = await buildApp(INFO_CONFIG, database, { write: (line) => lines.push(line) });
      registerProbeRoute(app, observed);
      const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      httpResponse = await postProbe(new URL(PROBE_PATH, baseUrl));
    } finally {
      await closeOwned(app, database);
    }

    if (observed.request === undefined || observed.replyHeaders === undefined) {
      throw new Error('probe did not finish');
    }

    const entries: Record<string, unknown>[] = [];
    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }
      // Destination writes are Pino JSON objects, one per line.
      entries.push(JSON.parse(line) as Record<string, unknown>);
    }
    const incoming = logWithMessage(entries, INCOMING_MESSAGE);
    const infoEntry = logWithMessage(entries, INFO_MESSAGE);
    const errorEntry = logWithMessage(entries, ERROR_MESSAGE);
    const completed = logWithMessage(entries, COMPLETED_MESSAGE);
    const requestId = incoming.reqId;
    const output = lines.join('');
    const body: unknown = JSON.parse(httpResponse.body);

    expect(infoEntry.level).toBe(30);
    expect(errorEntry.level).toBe(50);
    expect(infoEntry.reqId).toBe(requestId);
    expect(errorEntry.reqId).toBe(requestId);
    assertCensoredSnapshot(infoEntry);
    assertCensoredSnapshot(errorEntry);
    assertAutomaticMetadata(incoming, completed, requestId);
    for (const secret of SECRET_MARKERS) {
      expect(output).not.toContain(secret);
    }
    expect(observed.request.authorization).toBe(REQUEST_AUTHORIZATION);
    expect(observed.request.cookie).toBe(REQUEST_COOKIE);
    expect(observed.request.setCookie).toEqual([REQUEST_SET_COOKIE]);
    expect(observed.request.probe).toBe(REQUEST_PROBE);
    expect(observed.request.body).toEqual({
      password: BODY_PASSWORD,
      currentPassword: BODY_CURRENT_PASSWORD,
      newPassword: BODY_NEW_PASSWORD,
      email: BODY_EMAIL,
    });
    expect(observed.replyHeaders.authorization).toBe(RESPONSE_AUTHORIZATION);
    expect(observed.replyHeaders.cookie).toBe(RESPONSE_COOKIE);
    expect(observed.replyHeaders['set-cookie']).toEqual([...RESPONSE_SET_COOKIES]);
    expect(observed.replyHeaders['x-trace']).toBe(RESPONSE_TRACE);
    expect(httpResponse.statusCode).toBe(200);
    expect(httpResponse.headers.authorization).toBe(RESPONSE_AUTHORIZATION);
    expect(httpResponse.headers.cookie).toBe(RESPONSE_COOKIE);
    expect(httpResponse.headers['set-cookie']).toEqual([...RESPONSE_SET_COOKIES]);
    expect(httpResponse.headers['x-trace']).toBe(RESPONSE_TRACE);
    expect(body).toEqual({ status: 'ok' });
  });
});
