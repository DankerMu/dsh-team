import { expect, it } from 'vitest';
import { rejectPluginFailures } from './plugin-failure-markers.ts';

const MESSAGE = 'Plugin load failed';
const LAUNCH = 'dsh web: http://172.30.0.2:3080/?token=[REDACTED]\n';

it('accepts a clean released Web boot', () => {
  expect(() => {
    rejectPluginFailures({ stdout: LAUNCH, stderr: '' }, MESSAGE);
  }).not.toThrow();
});

it.each([
  [
    'an optional entry that did not activate',
    'dsh: warning: 1 entry did not activate\ndsh-team-platform-credentials (@deepseek-ai/dsh-credentials-local): failed to import\n',
    'did not activate',
  ],
  [
    'pending optional entries',
    'dsh: warning: 2 entries did not activate\na (x): pending (waiting for service: credentials)\nb (y): pending (waiting for service: credentials)\n',
    'did not activate',
  ],
  [
    'a required startup failure',
    'dsh: startup failed: 1 required plugin did not activate\n\nFailed plugins (1):\n  webserver\n',
    'Failed plugins (',
  ],
  [
    'a skipped bundle',
    'dsh: skipping profile bundle office-agents: engines\n',
    'dsh: skipping profile bundle',
  ],
  [
    'a disabled inserted row',
    'dsh: disabling profile plugin platform-nav: engines\n',
    'dsh: disabling profile plugin',
  ],
])('rejects %s on either stream', (_label, diagnostic, marker) => {
  for (const logs of [
    { stdout: LAUNCH, stderr: diagnostic },
    { stdout: `${LAUNCH}${diagnostic}`, stderr: '' },
  ]) {
    expect(() => {
      rejectPluginFailures(logs, MESSAGE);
    }).toThrow(`${MESSAGE}: ${marker}`);
  }
});
