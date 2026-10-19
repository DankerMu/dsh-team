import { expect, it } from 'vitest';
import { runOwnerScenario } from './ci-vps-owner-fixture.ts';

// The owned process fixture fails at10s; allow its forced failure-path settlement to finish.
const OWNER_CASE_TIMEOUT = 15_000;

it(
  'keeps failed model execution independent from confirmed host and credential retirement',
  async () => {
    const result = await runOwnerScenario('valid-execution-failure');

    expect(result.exit).toBe(1);
    expect(result.result).toMatchObject({ cleanupComplete: true, exitCode: 1 });
    expect(result.localFinal).toEqual({ vpsCleanupComplete: true, failures: [], exitCode: 1 });
    expect(result.lockTarget).toBeUndefined();
    expect(result.githubSecretAbsent).toBe(true);
    expect(result.privateKeyAbsent).toBe(true);
  },
  OWNER_CASE_TIMEOUT,
);

it(
  'recovers canonical cleanup success after the initial host observer failed',
  async () => {
    const result = await runOwnerScenario('observer-error');

    expect(result.hostFinal).toEqual({ vpsCleanupComplete: true, failures: [], exitCode: 1 });
    expect(result.exit).toBe(1);
    expect(result.result).toMatchObject({ cleanupComplete: true, exitCode: 1 });
    expect(result.localFinal).toEqual(result.hostFinal);
    expect(result.lockTarget).toBeUndefined();
    expect(result.githubSecretAbsent).toBe(true);
    expect(result.privateKeyAbsent).toBe(true);
    expect(result.observation).toMatchObject({
      kind: 'nonzero-exit',
      processExitCode: 255,
      signal: null,
      stdoutBytes: 0,
    });
    expect(result.recovery).toEqual({
      receiptSource: 'canonical',
      canonicalRead: 'valid',
      ownership: 'owned',
      cleanupConfirmed: true,
    });
  },
  OWNER_CASE_TIMEOUT,
);

it(
  'retains the admission lock when the installation owner cannot be confirmed',
  async () => {
    const result = await runOwnerScenario('foreign-owner');

    expect(result.exit).toBe(1);
    expect(result.result).toMatchObject({ cleanupComplete: false, exitCode: 1 });
    expect(result.lockTarget).toBe(result.invocation);
    expect(result.hostFinal).toBeUndefined();
    expect(result.localFinal).toBeUndefined();
    expect(result.githubSecretAbsent).toBe(true);
    expect(result.privateKeyAbsent).toBe(true);
  },
  OWNER_CASE_TIMEOUT,
);

it(
  'uses a complete observer receipt when its process exits before the final stdout bytes',
  async () => {
    const result = await runOwnerScenario('late-stdout');

    expect(result.hostFinal).toEqual({ vpsCleanupComplete: true, failures: [], exitCode: 1 });
    expect(result.result).toMatchObject({ cleanupComplete: true, exitCode: 1 });
    expect(result.localFinal).toEqual(result.hostFinal);
    expect(result.lockTarget).toBeUndefined();
    expect(result.githubSecretAbsent).toBe(true);
  },
  OWNER_CASE_TIMEOUT,
);

it(
  'does not retire its lock when invocation ownership changes during canonical receipt reading',
  async () => {
    const result = await runOwnerScenario('changed-owner');

    expect(result.hostFinal).toEqual({ vpsCleanupComplete: true, failures: [], exitCode: 1 });
    expect(result.result).toMatchObject({ cleanupComplete: false, exitCode: 1 });
    expect(result.localFinal).toEqual({ vpsCleanupComplete: false, exitCode: 1 });
    expect(result.lockTarget).toBe(result.invocation);
    expect(result.recovery).toMatchObject({
      receiptSource: 'canonical',
      ownership: 'foreign',
      cleanupConfirmed: false,
    });
  },
  OWNER_CASE_TIMEOUT,
);

it(
  'preserves another invocation admission symlink after its own cleanup is confirmed',
  async () => {
    const result = await runOwnerScenario('foreign-lock');

    expect(result.result).toMatchObject({ cleanupComplete: true, exitCode: 1 });
    expect(result.lockTarget).toBe('foreign-invocation');
    expect(result.localFinal).toEqual({ vpsCleanupComplete: true, failures: [], exitCode: 1 });
  },
  OWNER_CASE_TIMEOUT,
);

it(
  'rechecks current installation authority at the exact lock-removal boundary',
  async () => {
    const result = await runOwnerScenario('owner-changed-at-unlock');

    expect(result.result).toMatchObject({ cleanupComplete: false, exitCode: 1 });
    expect(result.lockTarget).toBe(result.invocation);
  },
  OWNER_CASE_TIMEOUT,
);

it(
  'keeps a valid cleanup failure terminal even when model execution succeeded',
  async () => {
    const result = await runOwnerScenario('cleanup-failed');

    expect(result.localFinal).toEqual({
      vpsCleanupComplete: false,
      failures: ['docker-rescue'],
      exitCode: 0,
    });
    expect(result.result).toMatchObject({ cleanupComplete: false, exitCode: 1 });
    expect(result.lockTarget).toBe(result.invocation);
    expect(result.recovery).toMatchObject({
      receiptSource: 'observer',
      canonicalRead: 'not-attempted',
      cleanupConfirmed: false,
    });
  },
  OWNER_CASE_TIMEOUT,
);

it.each([
  ['canonical-missing', 'failed'],
  ['canonical-invalid', 'invalid'],
  ['canonical-inconsistent', 'invalid'],
  ['canonical-unreachable', 'failed'],
  ['canonical-oversized', 'failed'],
] as const)(
  'retains unknown cleanup and its lock for %s',
  async (mode, canonicalRead) => {
    const result = await runOwnerScenario(mode);

    expect(result.result).toMatchObject({ cleanupComplete: false, exitCode: 1 });
    expect(result.localFinal).toEqual({ vpsCleanupComplete: false, exitCode: 1 });
    expect(result.lockTarget).toBe(result.invocation);
    expect(result.recovery).toEqual({
      receiptSource: 'unconfirmed',
      canonicalRead,
      ownership: 'owned',
      cleanupConfirmed: false,
    });
    const retained = JSON.stringify([
      result.result,
      result.localFinal,
      result.observation,
      result.recovery,
    ]);
    expect(retained.includes(result.canary)).toBe(false);
    expect(result.output.includes(result.canary)).toBe(false);
  },
  OWNER_CASE_TIMEOUT,
);

it.each([
  ['observer-invalid', 'invalid-receipt'],
  ['observer-oversized', 'output-limit'],
  ['observer-signal', 'terminated'],
  ['observer-spawn-error', 'spawn-error'],
  ['observer-stream-error', 'stream-error'],
  ['observer-timeout', 'deadline'],
] as const)(
  'retains sanitized %s evidence separately from authoritative recovery',
  async (mode, kind) => {
    const result = await runOwnerScenario(mode);

    expect(result.result).toMatchObject({ cleanupComplete: true, exitCode: 1 });
    expect(result.localFinal).toEqual({ vpsCleanupComplete: true, failures: [], exitCode: 1 });
    expect(result.lockTarget).toBeUndefined();
    expect(result.observation).toMatchObject({
      kind,
      timeoutMs: 1_850_000,
      outputLimitBytes: 16_384,
    });
    expect(result.recovery).toMatchObject({ receiptSource: 'canonical', canonicalRead: 'valid' });
    if (mode === 'observer-timeout')
      expect(result.observation).toMatchObject({ signal: 'SIGTERM', terminationRequested: true });
    if (mode === 'observer-oversized')
      expect(result.observation).toMatchObject({ stdoutBytes: 16_385 });
    const retained = JSON.stringify([
      result.result,
      result.localFinal,
      result.observation,
      result.recovery,
    ]);
    expect(retained.includes(result.canary)).toBe(false);
    expect(result.output.includes(result.canary)).toBe(false);
  },
  OWNER_CASE_TIMEOUT,
);

it(
  'projects only validated receipt fields rather than retaining raw observer extras',
  async () => {
    const result = await runOwnerScenario('observer-extra-fields');

    expect(result.localFinal).toEqual({ vpsCleanupComplete: true, failures: [], exitCode: 1 });
    expect(result.result).toMatchObject({ cleanupComplete: true, exitCode: 1 });
    expect(result.observation).toMatchObject({ kind: 'receipt', processExitCode: 0 });
    expect(result.lockTarget).toBeUndefined();
    const retained = JSON.stringify([
      result.result,
      result.localFinal,
      result.observation,
      result.recovery,
    ]);
    expect(retained.includes(result.canary)).toBe(false);
    expect(result.output.includes(result.canary)).toBe(false);
  },
  OWNER_CASE_TIMEOUT,
);
