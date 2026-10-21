import type * as Os from 'node:os';
import { expect, it, vi } from 'vitest';
import { verifyDeployedCredentialPrivacy } from './deployment-privacy-fixture.ts';

const admission = vi.hoisted((): { failure: Error | undefined } => ({ failure: undefined }));

// Exercise the real host-admission rejection on every integration host, without
// starting flock, Docker, administrator terminals or a provider.
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  platform: () => {
    if (admission.failure) throw admission.failure;
    return 'darwin';
  },
}));

it('retains the genuine early host-admission failure without entering account or stop work', async () => {
  const emitted = vi.spyOn(process.stdout, 'write');
  const expected = {
    current: 'deployment-host-admission',
    lastCompleted: null,
    firstFailure: {
      phase: 'deployment-host-admission',
      code: 'operation-failed',
      cause: 'unknown',
    },
    operations: { 'deployment-host-admission': 'failed' },
    cleanup: { deploymentDrain: 'not-required', resources: 'not-required' },
    evidence: 'retained',
  };

  try {
    const failure: unknown = await verifyDeployedCredentialPrivacy().catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty('setup', expected);
    const reports = emitted.mock.calls
      .filter(([chunk]) => typeof chunk === 'string' && chunk.startsWith('{"deploymentSetup":'))
      .map(([chunk]): unknown => JSON.parse(String(chunk)));
    expect(reports).toEqual([{ deploymentSetup: expected }]);
  } finally {
    emitted.mockRestore();
  }
});

it('keeps the primary admission facts and reports evidence loss when the output sink rejects without retrying or leaking either error', async () => {
  admission.failure = Object.assign(
    new AggregateError(
      [new Error('private-source-member-canary')],
      'private-source-message-canary',
      { cause: new Error('private-source-cause-canary') },
    ),
    {
      output: 'private-source-output-canary',
      args: ['private-source-argument-canary'],
      env: 'private-source-environment-canary',
    },
  );
  const sinkError = Object.assign(new Error('private-sink-message-canary'), {
    cause: new Error('private-sink-cause-canary'),
    output: 'private-sink-output-canary',
  });
  let attempts = 0;
  let failure: unknown;

  try {
    failure = await verifyDeployedCredentialPrivacy(() => {
      attempts++;
      throw sinkError;
    }).catch((error: unknown) => error);
  } finally {
    admission.failure = undefined;
  }

  expect(attempts).toBe(1);
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Missing sanitized privacy rejection');
  expect(failure).not.toBe(sinkError);
  expect(failure).not.toHaveProperty('cause');
  expect(failure).not.toHaveProperty('errors');
  expect(failure).toHaveProperty('setup', {
    current: 'deployment-host-admission',
    lastCompleted: null,
    firstFailure: {
      phase: 'deployment-host-admission',
      code: 'operation-failed',
      cause: 'unknown',
    },
    operations: { 'deployment-host-admission': 'failed' },
    cleanup: { deploymentDrain: 'not-required', resources: 'not-required' },
    evidence: 'unavailable',
  });
  const exposed = Object.fromEntries(
    Object.getOwnPropertyNames(failure).map((key): [string, unknown] => [
      key,
      Reflect.get(failure, key),
    ]),
  );
  expect(JSON.stringify(exposed)).not.toContain('private-');
  // Real Vitest rejects.toThrow consumers may print only the message, discarding Error.setup.
  expect(failure.message).toContain('setup-evidence-unavailable');
});
