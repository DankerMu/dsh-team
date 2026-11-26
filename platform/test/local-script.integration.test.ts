import { expect, it } from 'vitest';
import { localScript } from './local-script.ts';

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
