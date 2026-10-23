import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FILE_SIZE_LIMIT_PROGRAM } from './trusted-docker-fixture.ts';

const moduleUrl = new URL('../../scripts/trusted-docker-output.mjs', import.meta.url).href;
const canary = 'fixture-proxy-custody-canary';
const replacement = Buffer.from('[REDACTED]');

function consumer(split: boolean): string {
  return `import {capturePrivateOutput} from ${JSON.stringify(moduleUrl)};
async function* chunks() {
  for await (const chunk of process.stdin) {
    if (${String(split)}) {
      for (let offset = 0; offset < chunk.length; offset++) yield chunk.subarray(offset, offset + 1);
    } else yield chunk;
  }
}
try {
  const result = await capturePrivateOutput(chunks(), process.argv[1], [${JSON.stringify(canary)}]);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error.code === 'output-capture-failed' ? error.code : 'unclassified');
  process.exitCode = 7;
}`;
}

it.each([
  { name: 'one-byte chunks including UTF-8 and binary bytes', split: true, padding: 0 },
  { name: 'a complete multi-megabyte stream', split: false, padding: 2 * 1024 * 1024 },
])('retains ordered private output with secrets excluded across $name', (scenario) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-team-output-custody-'));
  const path = join(directory, 'stdout.log');
  const prefix = Buffer.concat([Buffer.from('开始\n'), Buffer.from([0, 255])]);
  const suffix = Buffer.concat([Buffer.alloc(scenario.padding, 120), Buffer.from('\n结束')]);
  const input = Buffer.concat([prefix, Buffer.from(canary), suffix, Buffer.from(canary)]);
  const expected = Buffer.concat([prefix, replacement, suffix, replacement]);
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', consumer(scenario.split), path],
      {
        input,
        env: { PATH: process.env.PATH },
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 65_536,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(readFileSync(path).equals(expected)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const receipt: unknown = JSON.parse(result.stdout.toString());
    expect(receipt).toEqual({
      bytes: expected.length,
      sha256: createHash('sha256').update(expected).digest('hex'),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('refuses to overwrite a prior output artifact instead of corrupting its evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-team-output-custody-'));
  const path = join(directory, 'stdout.log');
  writeFileSync(path, 'prior invocation evidence', { mode: 0o600 });
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', consumer(false), path],
      {
        input: canary,
        env: { PATH: process.env.PATH },
        timeout: 10_000,
        killSignal: 'SIGKILL',
      },
    );

    expect(result.status).toBe(7);
    expect(result.stderr.toString()).toBe('output-capture-failed');
    expect(readFileSync(path, 'utf8')).toBe('prior invocation evidence');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('does not return a complete receipt when the actual output file reaches its write limit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-team-output-custody-'));
  const path = join(directory, 'stdout.log');
  const input = Buffer.concat([Buffer.from(canary), Buffer.alloc(8192, 120)]);
  const expected = Buffer.concat([replacement, Buffer.alloc(8192, 120)]);
  try {
    const result = spawnSync(
      'python3',
      [
        '-c',
        FILE_SIZE_LIMIT_PROGRAM,
        process.execPath,
        '--input-type=module',
        '-e',
        consumer(false),
        path,
      ],
      {
        input,
        env: { PATH: process.env.PATH },
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 65_536,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(result.stderr.toString()).toBe('output-capture-failed');
    expect(result.stdout.toString()).toBe('');
    const retained = readFileSync(path);
    expect(retained.length).toBeLessThanOrEqual(4096);
    expect(retained).toEqual(expected.subarray(0, retained.length));
    expect(retained.includes(Buffer.from(canary))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
