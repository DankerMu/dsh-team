import { expect, it } from 'vitest';
import * as host from './index.js';

it('exports only the plugin name and an apply function', () => {
  expect(Object.keys(host).sort()).toEqual(['apply', 'name']);
  expect(host.name).toBe('dsh-team-office-hints');
  expect(typeof host.apply).toBe('function');
});

it('applies without touching the host context or config', () => {
  const untouchable = new Proxy(
    {},
    {
      get: () => {
        throw new Error('host context read');
      },
    },
  );

  expect(host.apply(untouchable, untouchable)).toBeUndefined();
});
