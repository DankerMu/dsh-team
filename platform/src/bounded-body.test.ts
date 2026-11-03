import { expect, it } from 'vitest';
import { readLimited } from './bounded-body.ts';

/** Enqueues the given chunk sizes, then closes; records whether the reader cancelled it. */
function chunked(sizes: readonly number[]) {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = sizes[state.pulls];
      state.pulls += 1;
      if (size === undefined) controller.close();
      else controller.enqueue(new Uint8Array(size).fill(0x61));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(stream), state };
}

it('returns the whole text of a body exactly at the limit', async () => {
  const { response, state } = chunked([6, 4]);

  const text = await readLimited(response, 10);

  expect(text).toBe('a'.repeat(10));
  expect(state.cancelled).toBe(false);
});

it('returns null one byte over the limit and cancels the rest of the stream', async () => {
  const { response, state } = chunked([6, 5, 1_048_576]);

  const text = await readLimited(response, 10);

  expect(text).toBeNull();
  expect(state.cancelled).toBe(true);
  expect(state.pulls).toBeLessThanOrEqual(3);
});

it('decodes multi-byte UTF-8 split across chunks', async () => {
  const bytes = new TextEncoder().encode('版本');
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    }),
  );

  expect(await readLimited(response, 6)).toBe('版本');
});

it('returns an empty string for a response without a body', async () => {
  expect(await readLimited(new Response(null, { status: 204 }), 10)).toBe('');
});

it('still returns null when cancelling the oversized stream fails', async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(11));
      },
      cancel() {
        throw new Error('owned cancellation failure');
      },
    }),
  );

  expect(await readLimited(response, 10)).toBeNull();
});
