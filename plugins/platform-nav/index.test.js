import { expect, it } from 'vitest';
import { apply } from './index.js';

function inject(config) {
  const handlers = new Map();
  apply({ on: (event, handler) => handlers.set(event, handler) }, config);
  const table = [];
  handlers.get('webserver/index-inject')(table);
  return { events: [...handlers.keys()], table };
}

it.each([
  ['an administrator', { admin: true }, true],
  ['an employee', { admin: false }, false],
  ['a missing flag', {}, false],
  ['a string flag', { admin: 'true' }, false],
  ['a numeric flag', { admin: 1 }, false],
  ['an absent config', undefined, false],
  ['a null config', null, false],
  ['a non-object config', 'admin', false],
])('publishes exactly one normalised page global for %s', (_name, config, admin) => {
  const { events, table } = inject(config);

  expect(events).toEqual(['webserver/index-inject']);
  expect(table).toEqual([{ kind: 'global', name: '__DSH_TEAM_PLATFORM_NAV__', value: { admin } }]);
});

it('reads the launch-time flag once and republishes it for every served page', () => {
  const handlers = new Map();
  const config = { admin: true };
  apply({ on: (event, handler) => handlers.set(event, handler) }, config);
  config.admin = false;
  const first = [];
  const second = [{ kind: 'style', text: '' }];

  handlers.get('webserver/index-inject')(first);
  handlers.get('webserver/index-inject')(second);

  expect(first).toEqual([
    { kind: 'global', name: '__DSH_TEAM_PLATFORM_NAV__', value: { admin: true } },
  ]);
  expect(second.at(-1)).toEqual(first[0]);
  expect(second).toHaveLength(2);
});
