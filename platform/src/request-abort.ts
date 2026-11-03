import type { FastifyReply } from 'fastify';

/**
 * Runs one request's outbound work under a signal that aborts when the client disconnects or the
 * application shuts down. Rejections, including that cancellation, reach the caller unchanged.
 */
export async function withRequestAbort<Result>(
  reply: FastifyReply,
  shutdown: AbortSignal,
  run: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const owner = new AbortController();
  // The response, not the request stream, closes when the client disconnects before a reply.
  const disconnected = () => {
    owner.abort();
  };
  reply.raw.once('close', disconnected);
  try {
    return await run(AbortSignal.any([owner.signal, shutdown]));
  } finally {
    reply.raw.off('close', disconnected);
  }
}
