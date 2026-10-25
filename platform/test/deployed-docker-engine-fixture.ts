import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { SUBMISSION_PENDING } from '../../scripts/verification-submission-storage.mjs';

export interface FixturePlatform {
  Id: string;
  Image: string;
  State: { Running: boolean; StartedAt: string };
}
// System-wide monotonic clock in milliseconds, directly comparable with the compiled child's.
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;

interface ObserverEngineInput {
  directory: string;
  stalls: boolean;
  platformInspect: FixturePlatform;
  ownedId: string;
  name: string;
  resources: Map<string, unknown>;
  createPath: string;
  inspectPath: string;
  deletePath: string;
}
interface ObserverEngineState {
  markersBeforeBinding: string[];
  persisted: boolean;
  stalledConnectionClosed: Promise<unknown> | undefined;
  logClosed: Promise<unknown> | undefined;
  received: number | null;
  bodyEnded: number | null;
  responseFinished: number | null;
  responseClosed: number | null;
  dispatchedSettled: boolean;
}

function createObserverEngineFixture(input: ObserverEngineInput) {
  const {
    directory,
    stalls,
    platformInspect,
    ownedId,
    name,
    resources,
    createPath,
    inspectPath,
    deletePath,
  } = input;
  const requests: { method: string | undefined; path: string | undefined; body: string }[] = [];
  const parentInspections: string[] = [];
  const dispatched = Promise.withResolvers<undefined>();
  const bound = Promise.withResolvers<undefined>();
  const observation: ObserverEngineState = {
    markersBeforeBinding: [],
    persisted: false,
    stalledConnectionClosed: undefined,
    logClosed: undefined,
    received: null,
    bodyEnded: null,
    responseFinished: null,
    responseClosed: null,
    dispatchedSettled: false,
  };
  // The worker loop observes receipt/finish; a blocked loop can delay them independently.
  const eventLoopDelay = monitorEventLoopDelay();
  eventLoopDelay.enable();
  const server = createServer((request, response) => {
    const received = monotonicMs();
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const bodyEnded = monotonicMs();
      const text = Buffer.concat(chunks).toString();
      if (request.method === 'GET' && request.url === `/containers/${platformInspect.Id}/json`) {
        parentInspections.push(request.url);
        response.end(JSON.stringify(platformInspect));
        return;
      }
      requests.push({ method: request.method, path: request.url, body: text });
      if (request.method === 'POST' && request.url === createPath) {
        observation.received = received;
        observation.bodyEnded = bodyEnded;
        // finish: handed to the kernel socket buffer; an aborting peer can yield close only.
        response.once('finish', () => {
          observation.responseFinished = monotonicMs();
        });
        response.once('close', () => {
          observation.responseClosed = monotonicMs();
        });
        const document: unknown = JSON.parse(text);
        resources.set(ownedId, { Id: ownedId, Name: `/${name}`, Config: document });
        observation.persisted = true;
        observation.markersBeforeBinding = readdirSync(join(directory, SUBMISSION_PENDING));
        dispatched.resolve(undefined);
        observation.dispatchedSettled = true;
        observation.stalledConnectionClosed = once(request.socket, 'close');
        response.writeHead(201);
        response.flushHeaders();
        if (stalls) response.write('{');
        else response.end(JSON.stringify({ Id: ownedId }));
      } else {
        // Hold real compensation/inspection I/O while the parent captures this live writer.
        void bound.promise.then(() => {
          if (response.destroyed) return;
          if (request.method === 'DELETE' && request.url === deletePath) {
            resources.delete(ownedId);
            response.writeHead(204).end();
          } else if (
            request.method === 'GET' &&
            request.url === inspectPath &&
            resources.has(ownedId)
          ) {
            response.end(JSON.stringify(resources.get(ownedId)));
          } else if (request.method === 'POST' && request.url === '/networks/create') {
            response.writeHead(403);
            response.flushHeaders();
          } else if (request.method === 'GET' && request.url === '/large') {
            response.end(JSON.stringify({ Data: 'x'.repeat(128) }));
          } else if (request.method === 'GET' && request.url === '/logs') {
            observation.logClosed = once(response, 'close');
            // Deliberately partial: the production contract yields byte fragments before frame end.
            response.write(Buffer.from('010000000000000361', 'hex'));
          } else {
            response.writeHead(404).end();
          }
        });
      }
    });
  });
  const evidence = () => ({
    received: observation.received,
    bodyEnded: observation.bodyEnded,
    responseFinished: observation.responseFinished,
    responseClosed: observation.responseClosed,
    dispatchedSettled: observation.dispatchedSettled,
    persisted: observation.persisted,
    markersBeforeBinding: observation.markersBeforeBinding,
    requests,
    maxEventLoopDelayMs: eventLoopDelay.max / 1e6,
  });
  const stopMonitoring = () => {
    eventLoopDelay.disable();
  };
  return {
    server,
    dispatched,
    bound,
    observation,
    requests,
    parentInspections,
    evidence,
    stopMonitoring,
  };
}

/** One owned engine plus the exact create/inspect/delete identities its observer scenario uses. */
export function observerScenarioInputs(directory: string, stalls: boolean) {
  const socket = join(directory, 'e.sock');
  const invocation = randomUUID();
  const ownedId = 'a'.repeat(64);
  const sentinelId = 'b'.repeat(64);
  const platformId = 'c'.repeat(64);
  const platformImage = `sha256:${'d'.repeat(64)}`;
  const platformInspect = {
    Id: platformId,
    Image: platformImage,
    State: { Running: true, StartedAt: '2026-01-02T03:04:05.123456789Z' },
  };
  const name = 'dsh-team-observer-owned';
  const body = { Image: 'owned-fixture-image', Labels: { 'dsh-team.test-run': invocation } };
  const sentinel = { Id: sentinelId, Name: '/unrelated-sentinel', Config: { Labels: {} } };
  const resources = new Map<string, unknown>([[sentinelId, sentinel]]);
  const createPath = `/containers/create?name=${name}`;
  const inspectPath = `/containers/${ownedId}/json`;
  const deletePath = `/containers/${ownedId}?force=true`;
  const engine = createObserverEngineFixture({
    directory,
    stalls,
    platformInspect,
    ownedId,
    name,
    resources,
    createPath,
    inspectPath,
    deletePath,
  });
  return {
    ...engine,
    socket,
    ownedId,
    sentinelId,
    platformInspect,
    name,
    body,
    sentinel,
    resources,
    createPath,
    inspectPath,
    deletePath,
  };
}
