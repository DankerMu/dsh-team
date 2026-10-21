import { expect, it } from 'vitest';
import { runBrowserBuildFailure } from './browser-build-fixture.ts';

it('retains a safe failed build receipt without retrying or claiming an absent tag was cleaned', async () => {
  const result = await runBrowserBuildFailure();

  expect(result.exit).toBe(1);
  expect(result.image).toMatchObject({
    imageId: null,
    state: 'build-failed',
    failure: {
      phase: 'image-build',
      termination: 'exit',
      exitStatus: 7,
      timeoutMs: 600_000,
      lastObservedBuildHeader: { vertex: 3, phase: 'metadata' },
    },
    cleanup: { browserResources: 'confirmed', image: 'ownership-unconfirmed' },
  });
  expect(result.imageMode).toBe(0o600);
  expect(result.qualification).toBeUndefined();
  expect(result.daemon).toMatchObject({
    removed: [],
    buildCount: 1,
    verificationStarted: false,
    runtimeClosureImported: true,
  });
  expect(JSON.stringify(result.image).includes(result.canary)).toBe(false);
  expect(result.output.includes(result.canary)).toBe(false);
});

it.each(['', '/missing-verification-runtime/runtime.json'])(
  'refuses an explicitly selected broken artifact descriptor %j before building or starting verification',
  async (artifactRuntime) => {
    const result = await runBrowserBuildFailure('absent', undefined, artifactRuntime);

    expect(result.exit).toBe(1);
    expect(result.daemon).toMatchObject({
      buildAttempts: 0,
      buildCount: 0,
      verificationStarted: false,
      removed: [],
      foreignImagePresent: true,
    });
    expect(result.image).toBeUndefined();
    expect(result.qualification).toBeUndefined();
    expect(result.output.includes(result.canary)).toBe(false);
  },
);

it.each([
  ['owned', 'confirmed', false],
  ['removal-failed', 'removal-failed', true],
] as const)(
  'distinguishes verified image retirement from %s cleanup failure',
  async (mode, cleanup, imagePresent) => {
    const result = await runBrowserBuildFailure(mode);
    const imageId = `sha256:${'a'.repeat(64)}`;

    expect(result.exit).toBe(1);
    expect(result.image).toMatchObject({
      imageId,
      state: 'build-failed',
      failure: { phase: 'image-build', exitStatus: 7 },
      cleanup: { browserResources: 'confirmed', image: cleanup },
    });
    expect(result.daemon).toMatchObject({
      removed: [imageId],
      buildCount: 1,
      verificationStarted: false,
      imagePresent,
      foreignImagePresent: true,
    });
    expect(JSON.stringify(result.image).includes(result.canary)).toBe(false);
    expect(result.output.includes(result.canary)).toBe(false);
  },
);

it.each(['foreign', 'changed-tag', 'malformed-id', 'inspect-failed'] as const)(
  'retains image resources when %s prevents current immutable ownership confirmation',
  async (mode) => {
    const result = await runBrowserBuildFailure(mode);

    expect(result.exit).toBe(1);
    expect(result.image).toMatchObject({
      imageId: null,
      state: 'build-failed',
      cleanup: { image: 'ownership-unconfirmed' },
    });
    expect(result.daemon).toMatchObject({
      removed: [],
      imagePresent: true,
      foreignImagePresent: true,
      buildCount: 1,
      verificationStarted: false,
    });
    expect(JSON.stringify(result.image).includes(result.canary)).toBe(false);
    expect(result.output.includes(result.canary)).toBe(false);
  },
);

it('keeps post-build qualification failure distinct from image admission failure', async () => {
  const result = await runBrowserBuildFailure('qualification-failed');

  expect(result.exit).toBe(1);
  expect(result.image).toMatchObject({ state: 'built' });
  expect(result.image).not.toHaveProperty('failure');
  expect(result.qualification).toMatchObject({
    state: 'failed',
    failureDomain: 'qualification',
    primary: { root: { phase: 'browser-launch' } },
  });
  expect(result.daemon).toMatchObject({
    buildCount: 1,
    verificationStarted: false,
    foreignImagePresent: true,
  });
  expect(JSON.stringify(result.qualification).includes(result.canary)).toBe(false);
  expect(result.output.includes(result.canary)).toBe(false);
});

it('retains the verified image when browser-resource retirement cannot be confirmed', async () => {
  const result = await runBrowserBuildFailure('browser-unconfirmed');

  expect(result.exit).toBe(1);
  expect(result.image).toMatchObject({
    state: 'built',
    cleanup: { browserResources: 'unconfirmed', image: 'blocked' },
  });
  expect(result.daemon).toMatchObject({
    removed: [],
    imagePresent: true,
    foreignImagePresent: true,
  });
});

it('does not remove an image when its required ownership receipt cannot be published', async () => {
  const result = await runBrowserBuildFailure('evidence-failed');

  expect(result.exit).toBe(1);
  expect(result.imageKind).toBe('other');
  expect(result.image).toBeUndefined();
  expect(result.daemon).toMatchObject({
    removed: [],
    imagePresent: true,
    foreignImagePresent: true,
    buildAttempts: 1,
    verificationStarted: false,
  });
  expect(result.output.includes(result.canary)).toBe(false);
});

it.each([
  ['deadline', 'deadline'],
  ['spawn-failed', 'spawn-failure'],
  ['output-limit', 'output-limit'],
  ['signal', 'signal'],
] as const)(
  'classifies the original %s build result without repeating admission',
  async (mode, termination) => {
    const result = await runBrowserBuildFailure(mode);

    expect(result.exit).toBe(1);
    expect(result.image).toMatchObject({
      state: 'build-failed',
      failure: { phase: 'image-build', termination, timeoutMs: 600_000 },
      cleanup: { image: 'ownership-unconfirmed' },
    });
    expect(result.daemon).toMatchObject({
      buildAttempts: 1,
      verificationStarted: false,
      removed: [],
      foreignImagePresent: true,
    });
    expect(result.qualification).toBeUndefined();
    expect(JSON.stringify(result.image).includes(result.canary)).toBe(false);
    expect(result.output.includes(result.canary)).toBe(false);
  },
);

it('reconfirms current tag ownership after publishing the immutable cleanup receipt', async () => {
  const result = await runBrowserBuildFailure('changed-after-publication');

  expect(result.exit).toBe(1);
  expect(result.image).toMatchObject({
    imageId: `sha256:${'a'.repeat(64)}`,
    state: 'build-failed',
    cleanup: { image: 'ownership-unconfirmed' },
  });
  expect(result.daemon).toMatchObject({
    tagChanged: true,
    removed: [],
    imagePresent: true,
    foreignImagePresent: true,
  });
});

it('preserves a failed ownership fence through independent worker finalization', async () => {
  const result = await runBrowserBuildFailure('changed-after-publication', 'changed');

  expect(result.rescued).toMatchObject({
    exit: 1,
    final: { vpsCleanupComplete: false, failures: ['browser-rescue'] },
  });
  expect(result.daemon).toMatchObject({
    removed: [],
    imagePresent: true,
    foreignImagePresent: true,
  });
  expect(result.rescued?.output.includes(result.canary)).toBe(false);
});

it.each(['missing', 'unreadable', 'foreign'] as const)(
  'retains images when independent rescue observes %s current authority',
  async (mode) => {
    const result = await runBrowserBuildFailure('changed-after-publication', mode);

    expect(result.rescued).toMatchObject({
      exit: 1,
      final: { vpsCleanupComplete: false, failures: ['browser-rescue'] },
    });
    expect(result.daemon).toMatchObject({
      removed: [],
      imagePresent: true,
      foreignImagePresent: true,
    });
    expect(result.rescued?.output.includes(result.canary)).toBe(false);
  },
);

it.each(['matching', 'old-built'] as const)(
  'retires an independently revalidated image from a %s receipt',
  async (mode) => {
    const result = await runBrowserBuildFailure('changed-after-publication', mode);

    expect(result.rescued).toMatchObject({
      exit: 0,
      final: { vpsCleanupComplete: true, failures: [] },
    });
    expect(result.daemon).toMatchObject({
      removed: [`sha256:${'a'.repeat(64)}`],
      imagePresent: false,
      foreignImagePresent: true,
    });
  },
);

it('accepts independently confirmed exact image absence without another removal', async () => {
  const result = await runBrowserBuildFailure('owned', 'matching');

  expect(result.rescued).toMatchObject({
    exit: 0,
    final: { vpsCleanupComplete: true, failures: [] },
  });
  expect(result.daemon).toMatchObject({
    removed: [`sha256:${'a'.repeat(64)}`],
    imagePresent: false,
    foreignImagePresent: true,
  });
});
