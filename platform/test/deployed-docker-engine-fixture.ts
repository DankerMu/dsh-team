import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { SUBMISSION_PENDING } from '../../scripts/verification-submission-storage.mjs';

export interface FixturePlatform {
  Id: string;
  Image: string;
  State: { Running: boolean; StartedAt: string };
}
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
}

export function createObserverEngineFixture(input: ObserverEngineInput) {
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
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      if (request.method === 'GET' && request.url === `/containers/${platformInspect.Id}/json`) {
        parentInspections.push(request.url);
        response.end(JSON.stringify(platformInspect));
        return;
      }
      requests.push({ method: request.method, path: request.url, body: text });
      if (request.method === 'POST' && request.url === createPath) {
        const document: unknown = JSON.parse(text);
        resources.set(ownedId, { Id: ownedId, Name: `/${name}`, Config: document });
        observation.persisted = true;
        observation.markersBeforeBinding = readdirSync(join(directory, SUBMISSION_PENDING));
        dispatched.resolve(undefined);
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
  return { server, dispatched, bound, observation, requests, parentInspections };
}
