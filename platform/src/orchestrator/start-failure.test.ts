import { expect, it } from 'vitest';
import {
  lastErrorCode,
  PROFILE_REJECTION_MARKERS,
  profileIncompatible,
  withFailureCode,
} from './start-failure.ts';

// dsh-app-boot 0.2.1-rc.2 lib/index.js `reportSkippedBundles` (:537-538) and
// `prepareProfileEntries` (:2305-2308) stderr templates, binName `dsh`.
const SKIPPED =
  'dsh: skipping profile bundle "@deepseek-ai/dsh-web-app": bundle is incompatible with dsh 0.2.1-rc.2';
const DISABLED = 'dsh: disabling profile plugin @dsh-team/office-agents: engines.dsh >=0.3.0';

it('names exactly the two released profile rejection prefixes', () => {
  expect(PROFILE_REJECTION_MARKERS).toEqual([
    'dsh: skipping profile bundle',
    'dsh: disabling profile plugin',
  ]);
});

it.each([
  [[SKIPPED], true],
  [['harmless boot line', DISABLED], true],
  [['harmless boot line'], false],
  [[], false],
  // Generic plugin failure labels are shared by every plugin failure, never profile-specific.
  [['plugin tree failed to load', 'Failed plugins (1): office-agents'], false],
  // Only a line prefix counts; the same words later in a line are not the released diagnostic.
  [[`note: ${SKIPPED}`, ` ${DISABLED}`], false],
  [['DSH: SKIPPING PROFILE BUNDLE "x": y'], false],
] as const)('classifies safe startup lines %j as profile-incompatible: %s', (lines, expected) => {
  expect(profileIncompatible(lines)).toBe(expected);
});

it('prefixes the closed code only for an incompatible profile and keeps the remainder verbatim', () => {
  const original = 'DSH readiness failed during startup; container stopped\nboot line';

  expect(withFailureCode(original, true)).toBe(`profile-incompatible\n${original}`);
  expect(withFailureCode(original, false)).toBe(original);
});

it.each([
  ['profile-incompatible\nDSH readiness failed; container stopped', 'profile-incompatible'],
  ['profile-incompatible', 'profile-incompatible'],
  ['profile-incompatible\r\nDSH readiness failed', null],
  [' profile-incompatible\nDSH readiness failed', null],
  ['profile-incompatible-extra\nDSH readiness failed', null],
  ['DSH readiness failed; container stopped\nprofile-incompatible', null],
  ['Platform attachment/startup failed; started container and owned network removed', null],
  ['', null],
  [null, null],
] as const)('derives the code from last error %j as %s', (lastError, expected) => {
  expect(lastErrorCode(lastError)).toBe(expected);
});

it('round-trips every written incompatible last error back to its code', () => {
  expect(lastErrorCode(withFailureCode('Platform attachment/startup failed; x', true))).toBe(
    'profile-incompatible',
  );
  expect(lastErrorCode(withFailureCode('Platform attachment/startup failed; x', false))).toBeNull();
});
