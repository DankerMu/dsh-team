import { expect, it } from 'vitest';
import { apply } from './index.js';

function inject(config) {
  const handlers = new Map();
  apply({ on: (event, handler) => handlers.set(event, handler) }, config);
  const table = [];
  handlers.get('webserver/index-inject')(table);
  return { events: [...handlers.keys()], table };
}

const global = (value) => [{ kind: 'global', name: '__DSH_TEAM_PLATFORM_NAV__', value }];

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
  expect(table).toEqual(global({ admin, pluginCatalog: {} }));
});

it('publishes the forced package states from the overlay row in their order', () => {
  const pluginCatalog = {
    '@dsh-team/office-agents': 'forced-off',
    '@dsh-team/permission-tiers': 'forced-on',
    'plain-package.name_1': 'forced-on',
  };

  const { table } = inject({ admin: false, pluginCatalog });

  expect(table).toEqual(global({ admin: false, pluginCatalog }));
  expect(Object.keys(table[0].value.pluginCatalog)).toEqual(Object.keys(pluginCatalog));
});

it('accepts an empty and a prototype-free state object', () => {
  const bare = Object.assign(Object.create(null), { '@dsh-team/zh-locale': 'forced-on' });

  expect(inject({ admin: true, pluginCatalog: {} }).table).toEqual(
    global({ admin: true, pluginCatalog: {} }),
  );
  expect(inject({ admin: true, pluginCatalog: bare }).table).toEqual(
    global({ admin: true, pluginCatalog: { '@dsh-team/zh-locale': 'forced-on' } }),
  );
});

const SECRET = 'leak-marker';
it.each([
  ['a null state object', null],
  ['an array', [`@dsh-team/${SECRET}`]],
  ['a string', SECRET],
  ['a number', 7],
  ['a non-plain object', new Map([[SECRET, 'forced-on']])],
  ['an employee state', { [`@dsh-team/${SECRET}`]: 'employee' }],
  ['an unknown state', { '@dsh-team/zh-locale': SECRET }],
  ['a non-string state', { '@dsh-team/zh-locale': true }],
  ['an upper-case name', { [`@dsh-team/${SECRET.toUpperCase()}`]: 'forced-on' }],
  ['a selector-breaking name', { [`${SECRET}"] *{display:none}`]: 'forced-on' }],
  ['an empty name', { '': 'forced-on' }],
  ['a scope without a name', { [`@${SECRET}/`]: 'forced-on' }],
  ['a nested scope', { [`@${SECRET}/a/b`]: 'forced-on' }],
])('rejects %s without echoing the input', (_name, pluginCatalog) => {
  const handlers = new Map();
  let thrown;
  try {
    apply({ on: (event, handler) => handlers.set(event, handler) }, { admin: true, pluginCatalog });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(TypeError);
  expect(thrown.message).not.toContain(SECRET);
  expect(thrown.message).not.toContain(SECRET.toUpperCase());
  expect(handlers.size).toBe(0);
});

it('reads the launch-time values once and republishes them for every served page', () => {
  const handlers = new Map();
  const config = { admin: true, pluginCatalog: { '@dsh-team/zh-locale': 'forced-on' } };
  apply({ on: (event, handler) => handlers.set(event, handler) }, config);
  config.admin = false;
  config.pluginCatalog['@dsh-team/zh-locale'] = 'forced-off';
  config.pluginCatalog['@dsh-team/office-agents'] = 'forced-on';
  const first = [];
  const second = [{ kind: 'style', text: '' }];

  handlers.get('webserver/index-inject')(first);
  handlers.get('webserver/index-inject')(second);

  expect(first).toEqual(
    global({ admin: true, pluginCatalog: { '@dsh-team/zh-locale': 'forced-on' } }),
  );
  expect(second.at(-1)).toEqual(first[0]);
  expect(second).toHaveLength(2);
});
