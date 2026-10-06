import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from './cli.ts';

async function invoke(args: readonly string[], inputTTY = false, outputTTY = false) {
  const input = Object.assign(new PassThrough(), { isTTY: inputTTY });
  const output = Object.assign(new PassThrough(), { isTTY: outputTTY });
  const errors = new PassThrough();
  const signals = new EventEmitter();
  let stdout = '';
  let stderr = '';
  output.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  errors.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    // Missing required config also proves rejection occurs before configuration/database access.
    const status = await runCli(args, {}, input, output, errors, signals);
    return { status, stdout, stderr, signals };
  } finally {
    input.destroy();
    output.destroy();
    errors.destroy();
  }
}

describe('administrator command validation', () => {
  it.each(
    [
      [],
      ['admin'],
      ['admin', 'create'],
      ['employee', 'create', 'user@example.com'],
      ['admin', 'delete', 'user@example.com'],
      ['admin', 'create', 'user@example.com', 'secret-password-sentinel'],
      ['admin', 'create', 'user@example.com', '--password=secret-password-sentinel'],
    ].map((args) => ({ args })),
  )('rejects unsupported arguments without disclosing supplied values: %j', async ({ args }) => {
    const result = await invoke(args);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/usage/i);
    expect(result.stderr).not.toContain('user@example.com');
    expect(result.stderr).not.toContain('secret-password-sentinel');
    expect(result.signals.eventNames()).toEqual([]);
  });

  it.each(['', 'invalid-email-sentinel', 'a@@b', 'a @b'])(
    'rejects invalid email without echo before terminal/configuration access: %j',
    async (email) => {
      const result = await invoke(['admin', 'create', email]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/invalid email/i);
      expect(result.stderr).not.toContain('sentinel');
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
  ])(
    'requires interactive input=%s and output=%s before configuration access',
    async (inputTTY, outputTTY) => {
      const result = await invoke(['admin', 'create', 'user@example.com'], inputTTY, outputTTY);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/interactive terminal/i);
      expect(result.stderr).not.toContain('user@example.com');
      expect(result.signals.eventNames()).toEqual([]);
    },
  );

  it('fails safely when required platform configuration is missing', async () => {
    const result = await invoke(['admin', 'create', 'user@example.com'], true, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/administrator command failed/i);
    expect(result.stderr).not.toContain('Error:');
    expect(result.stderr).not.toContain('user@example.com');
    expect(result.signals.eventNames()).toEqual([]);
  });
});
