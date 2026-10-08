import { request } from 'node:http';
import type { RequestOptions } from 'node:http';
import { isAbsolute } from 'node:path';
import type { Readable } from 'node:stream';

type Response = Readable & { statusCode?: number | undefined };
export type DockerTransport = (
  options: Pick<RequestOptions, 'socketPath' | 'method' | 'path' | 'headers'>,
  receive: (response: Response) => void,
) => DockerRequest;
interface DockerRequest {
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(body?: string): unknown;
  destroy(error?: Error): unknown;
}

interface DockerLogChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly data: Buffer;
}

export interface DockerClient {
  json(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
  logs(path: string, signal?: AbortSignal): AsyncGenerator<DockerLogChunk>;
}

export class DockerHttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number) {
    super(`Docker HTTP ${String(statusCode)}`);
    this.statusCode = statusCode;
  }
}

// Only stable transport codes are diagnostic; never retain raw errors or causes.
const SAFE_CODES: Record<string, true> = {
  ENOENT: true,
  EACCES: true,
  EPERM: true,
  ECONNREFUSED: true,
  ECONNRESET: true,
  EPIPE: true,
  ETIMEDOUT: true,
  ABORT_ERR: true,
  ERR_STREAM_PREMATURE_CLOSE: true,
};
class DockerTransportError extends Error {
  constructor(socketPath: string, error: unknown) {
    const code =
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      Object.hasOwn(SAFE_CODES, error.code)
        ? error.code
        : 'UNKNOWN';
    super(`Docker socket ${socketPath}: ${code}`);
  }
}

function readLogStream(header: Buffer): DockerLogChunk['stream'] {
  if (
    (header[0] !== 1 && header[0] !== 2) ||
    header[1] !== 0 ||
    header[2] !== 0 ||
    header[3] !== 0
  ) {
    throw new Error('Invalid Docker log frame');
  }
  return header[0] === 1 ? 'stdout' : 'stderr';
}

/** Lazy Unix-only client; endpoint consumers validate returned JSON documents. */
export function createDockerClient(
  socketPath: string,
  transport: DockerTransport = request,
): DockerClient {
  if (!isAbsolute(socketPath) || socketPath.includes('\0')) {
    throw new Error('Docker socket must be an absolute nonempty path without NUL');
  }
  async function* exchange(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<Buffer> {
    let outgoing: DockerRequest | undefined;
    let response: Response | undefined;
    let abort: (() => void) | undefined;
    try {
      response = await new Promise<Response>((resolve, reject) => {
        const fail = (error: unknown) => {
          const safe = new DockerTransportError(socketPath, error);
          reject(safe);
          response?.destroy(safe);
        };
        abort = () => {
          fail(Object.assign(new Error(), { code: 'ABORT_ERR' }));
          outgoing?.destroy();
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        outgoing = transport(
          {
            socketPath,
            method,
            path,
            headers:
              encoded === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(encoded),
                  },
          },
          (incoming) => {
            response = incoming;
            resolve(incoming);
          },
        );
        outgoing.on('error', fail);
        signal?.addEventListener('abort', abort, { once: true });
        outgoing.end(encoded);
      });
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) throw new DockerHttpError(status);
      for await (const chunk of response) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Invalid Docker response bytes');
        yield chunk;
      }
    } catch (error) {
      if (error instanceof DockerHttpError) throw error;
      // Sanitization also covers synchronous transport throws and response stream errors.
      if (error instanceof DockerTransportError) throw error;
      throw new DockerTransportError(socketPath, error);
    } finally {
      if (abort !== undefined) signal?.removeEventListener('abort', abort);
      response?.destroy();
      outgoing?.destroy();
    }
  }

  return {
    async json(
      method: string,
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ): Promise<unknown> {
      const chunks: Buffer[] = [];
      for await (const chunk of exchange(method, path, body, signal)) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0) return undefined;
      try {
        const document: unknown = JSON.parse(bytes.toString());
        return document;
      } catch {
        throw new Error('Invalid Docker JSON response');
      }
    },
    /** Non-TTY byte fragments, not whole frames or decoded text. AbortSignal cancels pending reads. */
    async *logs(path: string, signal?: AbortSignal): AsyncGenerator<DockerLogChunk> {
      // Keep only the fixed header; even a uint32-max frame is emitted in byte slices.
      const header = Buffer.alloc(8);
      let used = 0;
      let remaining = 0;
      let stream: DockerLogChunk['stream'] = 'stdout';
      for await (const chunk of exchange('GET', path, undefined, signal)) {
        let offset = 0;
        while (offset < chunk.length) {
          if (signal?.aborted) {
            throw new DockerTransportError(
              socketPath,
              Object.assign(new Error(), { code: 'ABORT_ERR' }),
            );
          }
          if (remaining === 0) {
            const count = Math.min(8 - used, chunk.length - offset);
            chunk.copy(header, used, offset, offset + count);
            used += count;
            offset += count;
            if (used < 8) continue;
            stream = readLogStream(header);
            remaining = header.readUInt32BE(4);
            used = 0;
            if (remaining === 0) continue;
          }
          const count = Math.min(remaining, chunk.length - offset);
          if (count === 0) continue;
          remaining -= count;
          yield { stream, data: chunk.subarray(offset, offset + count) };
          offset += count;
        }
      }
      if (used !== 0 || remaining !== 0) throw new Error('Truncated Docker log frame');
    },
  };
}
