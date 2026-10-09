import { expect, it } from 'vitest';
import { runLargeTransfer, STREAM_RSS_LIMIT } from './gateway-stream-fixture.ts';

it('streams a complete 200MiB upload and download within the gateway RSS ceiling', async ({
  signal,
}) => {
  const measurements = await runLargeTransfer('stream', 'src', { signal });
  process.stdout.write(
    `${JSON.stringify({ mode: 'stream', node: process.version, platform: process.platform, arch: process.arch, measurements })}\n`,
  );

  expect(measurements.map((result) => result.direction)).toEqual(['upload', 'download']);
  for (const result of measurements) {
    expect(result.bytes).toBe(209_715_200);
    expect(result.sha256).toBe('85a0a4c9fd74e8706e2a8f80d510a3a6a4255b015943d80b13d219667145351b');
    expect(result.mutated).toBe(false);
    expect(result.delta).toBeLessThanOrEqual(STREAM_RSS_LIMIT);
  }
}, 60_000); // Real 400MiB traffic plus child startup on loaded CI, not a timing oracle.

it.for(['buffer-upload', 'buffer-download'] as const)(
  'rejects actual %s while preserving complete transfer integrity',
  { timeout: 60_000 },
  async (mode, { signal }) => {
    const measurements = await runLargeTransfer(mode, 'src', { signal });
    process.stdout.write(
      `${JSON.stringify({ mode, node: process.version, platform: process.platform, arch: process.arch, measurements })}\n`,
    );

    expect(measurements.map((result) => result.direction)).toEqual(['upload', 'download']);
    for (const result of measurements) {
      expect(result.bytes).toBe(209_715_200);
      expect(result.sha256).toBe(
        '85a0a4c9fd74e8706e2a8f80d510a3a6a4255b015943d80b13d219667145351b',
      );
      expect(result.mutated).toBe(mode === `buffer-${result.direction}`);
    }
    const mutated = measurements.find((result) => mode === `buffer-${result.direction}`);
    expect(mutated?.delta).toBeGreaterThan(STREAM_RSS_LIMIT);
  },
); // A real full-body buffering control must complete, not merely time out.
