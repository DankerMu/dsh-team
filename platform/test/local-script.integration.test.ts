import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { endInput, localScript } from './local-script.ts';

// Far above a pipe's buffer: the child exits long before its stdin could take it all (#717).
const UNREAD = 'x'.repeat(8 * 1024 * 1024);

it('answers a child that exits without reading a large input, with no uncaught pipe error', async () => {
  const observed = await localScript(
    'process.stdout.write(JSON.stringify({ read: false }))',
    [],
    {},
    UNREAD,
  );

  expect(observed).toEqual({ read: false });
});

it('hands a reading child its whole input', async () => {
  const script = `let size = 0;
for await (const chunk of process.stdin) size += chunk.length;
process.stdout.write(JSON.stringify({ size }));`;

  const observed = await localScript(script, [], {}, UNREAD);

  expect(observed).toEqual({ size: UNREAD.length });
});

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

it('ignores a stdin closed without an error before it took the input, as at child exit', async () => {
  const stdin = new Writable({ write: () => undefined });

  const ended = endInput(stdin, 'input');
  stdin.destroy();

  await expect(ended).resolves.toBeUndefined();
});

it('rejects any other stdin error', async () => {
  await expect(endInput(failing('EIO'), 'input')).rejects.toThrow('stand-in EIO');
});
