import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const model = fileURLToPath(new URL('../../scripts/verify-browser-runtime.mjs', import.meta.url));
const operator = fileURLToPath(new URL('../../scripts/ci-vps-run.mjs', import.meta.url));

function withoutProvisioning(entry: string, args: string[], env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-team-model-entry-'));
  try {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: directory,
      // No executable search path: rejection must precede Docker/browser/SSH/GitHub commands.
      env: { HOME: directory, TMPDIR: directory, PATH: '', ...env },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(readdirSync(directory)).toEqual([]);
    return result.stderr;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.each([undefined, ''])('rejects a missing model credential before provisioning (%s)', (key) => {
  const diagnostic = withoutProvisioning(
    model,
    ['model'],
    key === undefined ? {} : { DMXAPI_KEY: key },
  );
  expect(diagnostic).toContain('DMXAPI_KEY');
});

it.each([
  ['main', 'refs/heads/codex/model'],
  ['a'.repeat(40), 'refs/pull/1/merge'],
  ['a'.repeat(40), 'refs/heads/main;touch-owned'],
  ['a'.repeat(40), 'refs/heads/codex/model', '--rerun=../foreign'],
  ['a'.repeat(40), 'refs/heads/main', '--rerun=1', 'unexpected'],
])('rejects unsafe operator revision/ref arguments before creating authority (%j)', (...args) => {
  withoutProvisioning(operator, args);
});

it('accepts an explicit rerun identity without bypassing reviewed-source availability', () => {
  const diagnostic = withoutProvisioning(operator, [
    'a'.repeat(40),
    'refs/heads/codex/model',
    '--rerun=1',
  ]);
  expect(diagnostic).toContain('Reviewed operator source unavailable');
  expect(diagnostic).not.toContain('Usage:');
});
