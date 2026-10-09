import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { observeHttp, sendHttp, withForwardingApp, withUpstream } from './gateway-http-fixture.ts';

it('delivers upload and response prefixes before either producer ends', async () => {
  const upload = Promise.withResolvers<string>();
  let body = '';
  await withUpstream(
    (incoming, response) => {
      incoming.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        upload.resolve(body);
        if (!response.headersSent) response.writeHead(201).write('response-prefix');
      });
      incoming.on('end', () => {
        response.end('-response-end');
      });
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ base, cookie }) => {
          const prefix = Promise.withResolvers<string>();
          const ended = Promise.withResolvers<string>();
          let output = '';
          const call = request(
            base,
            {
              method: 'POST',
              headers: { cookie, 'content-type': 'application/octet-stream' },
              signal: AbortSignal.timeout(5_000),
            },
            (response) => {
              response.on('data', (chunk: Buffer) => {
                output += chunk.toString();
                prefix.resolve(output);
              });
              response.once('end', () => {
                ended.resolve(output);
              });
              response.once('error', ended.reject);
            },
          );
          call.once('error', ended.reject);
          try {
            call.write('upload-prefix');
            expect(await observeHttp(upload.promise)).toBe('upload-prefix');
            expect(await observeHttp(prefix.promise)).toBe('response-prefix');
            expect(call.writableEnded).toBe(false);

            call.end('-upload-end');

            expect(await observeHttp(ended.promise)).toBe('response-prefix-response-end');
            expect(body).toBe('upload-prefix-upload-end');
          } finally {
            call.destroy();
          }
        },
      );
    },
  );
});

it('terminates an interrupted upstream response without appending a gateway error body', async () => {
  const upstreamResponse = Promise.withResolvers<ServerResponse>();
  await withUpstream(
    (incoming, response) => {
      if (incoming.url === '/healthy') {
        response.end('healthy');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' }).write('upstream-prefix');
      upstreamResponse.resolve(response);
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ base, cookie }) => {
          const prefix = Promise.withResolvers<undefined>();
          const completion = Promise.withResolvers<'end' | 'aborted'>();
          let output = '';
          const call = request(
            base,
            { headers: { cookie }, signal: AbortSignal.timeout(5_000) },
            (response) => {
              response.on('data', (chunk: Buffer) => {
                output += chunk.toString();
                prefix.resolve(undefined);
              });
              response.once('end', () => {
                completion.resolve('end');
              });
              response.once('aborted', () => {
                completion.resolve('aborted');
              });
              response.once('error', () => {
                completion.resolve('aborted');
              });
            },
          );
          call.once('error', completion.reject);
          call.end();
          try {
            await observeHttp(prefix.promise);
            (await observeHttp(upstreamResponse.promise)).destroy();

            expect(await observeHttp(completion.promise)).toBe('aborted');
            expect(output).toBe('upstream-prefix');
            expect(
              (await sendHttp(base, { path: '/healthy', headers: { cookie } })).body.toString(),
            ).toBe('healthy');
          } finally {
            call.destroy();
          }
        },
      );
    },
  );
});

it.each(['upload', 'download'] as const)(
  'releases the upstream socket after a client aborts its %s',
  async (mode) => {
    const observed = Promise.withResolvers<{
      incoming: IncomingMessage;
      closed: Promise<undefined>;
    }>();
    const upload = Promise.withResolvers<undefined>();
    const errors: Error[] = [];
    await withUpstream(
      (incoming, response) => {
        if (incoming.url === '/healthy') {
          response.end('healthy');
          return;
        }
        const { promise: closed, resolve } = Promise.withResolvers<undefined>();
        // An aborted chunked upload may emit a parser error before close; observe actual teardown.
        incoming.socket.once('close', () => {
          resolve(undefined);
        });
        incoming.socket.on('error', (error) => {
          errors.push(error);
        });
        observed.resolve({ incoming, closed });
        incoming.on('error', (error) => {
          errors.push(error);
        });
        incoming.on('data', () => {
          upload.resolve(undefined);
        });
        if (mode === 'download')
          incoming.on('end', () => {
            response.writeHead(200).write('download-prefix');
          });
      },
      async (target) => {
        await withForwardingApp(
          () => target,
          async ({ base, cookie }) => {
            const prefix = Promise.withResolvers<IncomingMessage>();
            const call = request(
              base,
              { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(5_000) },
              (response) => {
                response.once('data', () => {
                  prefix.resolve(response);
                });
                response.on('error', (error) => {
                  errors.push(error);
                });
              },
            );
            call.on('error', (error) => {
              errors.push(error);
            });
            try {
              if (mode === 'upload') call.write('unfinished-upload');
              else call.end('complete-upload');
              const peer = await observeHttp(observed.promise);
              if (mode === 'upload') {
                await observeHttp(upload.promise);
                expect(peer.incoming.complete).toBe(false);
                call.destroy();
              } else {
                const response = await observeHttp(prefix.promise);
                expect(peer.incoming.complete).toBe(true);
                response.destroy();
              }
              await observeHttp(peer.closed);

              expect(peer.incoming.socket.destroyed).toBe(true);
              expect(
                (await sendHttp(base, { path: '/healthy', headers: { cookie } })).body.toString(),
              ).toBe('healthy');
              expect(errors.map((error) => error.message).join('')).not.toContain(target.cookie);
            } finally {
              call.destroy();
            }
          },
        );
      },
    );
  },
);

it.each(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'TRACE'])(
  'preserves streamed %s bodies independently of Node framing defaults',
  async (method) => {
    let prefix = Promise.withResolvers<string>();
    const received: { method: string | undefined; body: string }[] = [];
    await withUpstream(
      (incoming, response) => {
        let body = '';
        incoming.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          prefix.resolve(body);
        });
        incoming.on('end', () => {
          received.push({ method: incoming.method, body });
          response.writeHead(201).end('accepted');
        });
      },
      async (target) => {
        await withForwardingApp(
          () => target,
          async ({ base, cookie }) => {
            for (const framing of ['chunked', 'length', 'nominated-length']) {
              prefix = Promise.withResolvers<string>();
              const outcome = Promise.withResolvers<{ status: number; body: string }>();
              const payload = '{"ids":[1]}';
              const headers =
                framing === 'chunked'
                  ? { cookie, 'transfer-encoding': 'chunked' }
                  : {
                      cookie,
                      'content-length': String(Buffer.byteLength(payload)),
                      ...(framing === 'nominated-length' ? { connection: 'Content-Length' } : {}),
                    };
              const call = request(
                base,
                { method, path: '/api/test', headers, signal: AbortSignal.timeout(5_000) },
                (response) => {
                  let body = '';
                  response.on('data', (chunk: Buffer) => {
                    body += chunk.toString();
                  });
                  response.on('error', outcome.reject);
                  response.once('end', () => {
                    outcome.resolve({ status: response.statusCode ?? 0, body });
                  });
                },
              );
              call.on('error', outcome.reject);
              try {
                call.write('{"ids":');
                const observed = await Promise.race([
                  observeHttp(prefix.promise),
                  outcome.promise.then(() => {
                    throw new Error('Upstream completed before receiving the body prefix');
                  }),
                ]);
                expect(observed).toBe('{"ids":');
                expect(call.writableEnded).toBe(false);
                call.end('[1]}');

                expect(await observeHttp(outcome.promise)).toEqual({
                  status: 201,
                  body: method === 'HEAD' ? '' : 'accepted',
                });
                expect(received.at(-1)).toEqual({ method, body: payload });
              } finally {
                call.destroy();
              }
            }
            expect(received).toEqual(
              Array.from({ length: 3 }, () => ({ method, body: '{"ids":[1]}' })),
            );
          },
        );
      },
    );
  },
);
