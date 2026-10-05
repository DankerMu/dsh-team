import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { expect } from 'vitest';
import type { DatabaseHandle } from '../src/db/index.ts';
import { PUBLIC_ORIGIN } from './auth-fixture.ts';
import { PASSWORD } from './auth-tcp-fixture.ts';
import {
  NEW_PASSWORD,
  type PasswordStateSnapshot,
  snapshotPasswordState,
} from './password-change-fixture.ts';

export const EMAIL = 'user@example.com';
export const FOREIGN_ORIGIN = 'https://other.example';
export const INVALID_ORIGIN = {
  statusCode: 403,
  error: 'Forbidden',
  message: 'Invalid request origin',
} as const;
export const JSON_REQUIRED = {
  statusCode: 415,
  error: 'Unsupported Media Type',
  message: 'JSON request body required',
} as const;

function mutationPayloads(cookie: string): {
  route: string;
  payload: Record<string, string>;
  cookie: string | undefined;
}[] {
  return [
    {
      route: 'register',
      payload: { email: 'fresh@example.com', password: PASSWORD },
      cookie: undefined,
    },
    { route: 'login', payload: { email: EMAIL, password: PASSWORD }, cookie: undefined },
    { route: 'logout', payload: {}, cookie },
    {
      route: 'change-password',
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      cookie,
    },
  ];
}

export interface RejectedRequest {
  label: string;
  route: string;
  body: string;
  headers: Readonly<Record<string, string | undefined>>;
  status: 403 | 415;
}

export function rejectedMutationRequests(cookie: string): RejectedRequest[] {
  const cases: RejectedRequest[] = [];
  for (const mutation of mutationPayloads(cookie)) {
    const body = JSON.stringify(mutation.payload);
    const headers = { cookie: mutation.cookie, 'content-type': 'application/json' };
    cases.push(
      {
        label: `${mutation.route}: missing Origin`,
        route: mutation.route,
        body,
        headers,
        status: 403,
      },
      {
        label: `${mutation.route}: foreign Origin`,
        route: mutation.route,
        body,
        headers: { ...headers, origin: FOREIGN_ORIGIN },
        status: 403,
      },
      {
        label: `${mutation.route}: form media`,
        route: mutation.route,
        body: new URLSearchParams(mutation.payload).toString(),
        headers: {
          cookie: mutation.cookie,
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
        },
        status: 415,
      },
    );
  }
  return cases;
}

export async function sendRejectedRequest(
  baseUrl: string,
  testCase: RejectedRequest,
): Promise<Response> {
  // Construct from scratch: omission must never inherit a positive helper's Origin default.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(testCase.headers)) {
    if (value !== undefined) headers[name] = value;
  }
  return fetch(`${baseUrl}/_platform/api/${testCase.route}?origin=ignored`, {
    method: 'POST',
    headers,
    body: testCase.body,
  });
}

export async function expectGuardRejection(
  response: Response,
  database: DatabaseHandle,
  before: PasswordStateSnapshot,
  status: 403 | 415,
  label: string,
): Promise<void> {
  expect(response.status, label).toBe(status);
  expect(await response.json(), label).toEqual(status === 403 ? INVALID_ORIGIN : JSON_REQUIRED);
  expect(response.headers.getSetCookie(), label).toEqual([]);
  expect(snapshotPasswordState(database), label).toEqual(before);
}

export interface RawResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Flat Node headers preserve physical repetitions and their original name casing. */
export function postRaw(
  baseUrl: string,
  route: string,
  payload: unknown,
  headers: string[],
): Promise<RawResponse> {
  const body = JSON.stringify(payload);
  const requestHeaders = [
    'Content-Type',
    'application/json',
    'Content-Length',
    String(Buffer.byteLength(body)),
    ...headers,
  ];
  let hasHost = false;
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() === 'host') {
      hasHost = true;
      break;
    }
  }
  // Flat Node header arrays do not synthesize HTTP/1.1's required Host header.
  if (!hasHost) {
    requestHeaders.push('Host', new URL(baseUrl).host);
  }
  const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
  const request = httpRequest(
    `${baseUrl}/_platform/api/${route}`,
    {
      method: 'POST',
      headers: requestHeaders,
    },
    (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    },
  );
  request.on('error', reject);
  request.end(body);
  return promise;
}
