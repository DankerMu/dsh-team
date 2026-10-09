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
