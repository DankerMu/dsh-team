import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { endInput } from './child-input.ts';

/** A stdin whose every write fails with `code`, as a pipe's would. */
const failing = (code: string) =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error(`stand-in ${code}`), { code }));
    },
  });

it('ignores a closed pipe on stdin', async () => {
  await expect(endInput(failing('EPIPE'), 'input')).resolves.toBeUndefined();
});

it('ignores a peer reset on stdin, as a Linux socketpair reports a child that exited unread', async () => {
  await expect(endInput(failing('ECONNRESET'), 'input')).resolves.toBeUndefined();
});

it('ignores a stdin closed without an error before it took the input, as at child exit', async () => {
  const stdin = new Writable({ write: () => undefined });

  const ended = endInput(stdin, 'input');
  stdin.destroy();

  await expect(ended).resolves.toBeUndefined();
});

it('rejects any other stdin error', async () => {
  await expect(endInput(failing('EIO'), 'input')).rejects.toThrow('stand-in EIO');
});
