import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { apply, name } from './index.js';

// The one fixed rejection message (the fixture's config contract); it never carries the input.
const REJECTED =
  'knowledge-base config must be absent or exactly { platformUrl: "http://<instance +3 IPv4>:<port>" }';

/** A host context that fails on any use: 15.1 registers nothing in either state. */
function untouchedContext() {
  const touched = [];
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) => {
        touched.push(String(key));
        throw new Error('host context used');
      },
    },
  );
  return { ctx, touched };
}

function rejection(config) {
  const { ctx, touched } = untouchedContext();
  try {
    apply(ctx, config);
  } catch (error) {
    expect(touched).toEqual([]);
    return error;
  }
  throw new Error('apply accepted the config');
}

it('names the host plugin', () => {
  expect(name).toBe('dsh-team-knowledge-base');
});

it.each([
  ['an absent config', undefined],
  ['a null config', null],
  ['an empty object', {}],
  ['an empty prototype-free object', Object.create(null)],
])('treats %s as the designed no-platform-address state', (_label, config) => {
  const { ctx, touched } = untouchedContext();

  expect(apply(ctx, config)).toBeUndefined();
  expect(touched).toEqual([]);
});

it.each([
  'http://172.30.0.3:8080',
  'http://172.30.0.19:8080',
  'http://10.0.0.3:1',
  'http://10.0.0.3:65535',
  'http://255.255.255.243:443',
  'http://0.0.0.3:80',
])('accepts the instance +3 platform address %s without touching the host', (platformUrl) => {
  for (const config of [{ platformUrl }, Object.assign(Object.create(null), { platformUrl })]) {
    const { ctx, touched } = untouchedContext();

    expect(apply(ctx, config)).toBeUndefined();
    expect(touched).toEqual([]);
  }
});

const VALID = 'http://172.30.0.3:8080';
it.each([
  ['an extra key', { platformUrl: VALID, token: 'kb-sentinel' }],
  ['only another key', { ragflowApiKey: 'kb-sentinel' }],
  ['a symbol key', { [Symbol('kb-sentinel')]: VALID }],
  ['a numeric address', { platformUrl: 1720003 }],
  ['a null address', { platformUrl: null }],
  ['an object address', { platformUrl: new URL(VALID) }],
  [
    'an accessor address',
    Object.defineProperty({}, 'platformUrl', { get: () => VALID, enumerable: true }),
  ],
  ['an https address', { platformUrl: 'https://172.30.0.3:8080' }],
  ['an upper-case scheme', { platformUrl: 'HTTP://172.30.0.3:8080' }],
  ['a leading-zero octet', { platformUrl: 'http://172.030.0.3:8080' }],
  ['a leading-zero last octet', { platformUrl: 'http://172.30.0.03:8080' }],
  ['an out-of-range octet', { platformUrl: 'http://172.256.0.3:8080' }],
  ['a three-octet address', { platformUrl: 'http://172.30.3:8080' }],
  ['a host name', { platformUrl: 'http://kb-sentinel.invalid:8080' }],
  ['the employee +2 address', { platformUrl: 'http://172.30.0.2:8080' }],
  ['the Document Server +4 address', { platformUrl: 'http://172.30.0.4:8080' }],
  ['a missing port', { platformUrl: 'http://172.30.0.3' }],
  ['an empty port', { platformUrl: 'http://172.30.0.3:' }],
  ['port 0', { platformUrl: 'http://172.30.0.3:0' }],
  ['port 65536', { platformUrl: 'http://172.30.0.3:65536' }],
  ['a leading-zero port', { platformUrl: 'http://172.30.0.3:08080' }],
  ['a path', { platformUrl: `${VALID}/kb-sentinel` }],
  ['a trailing slash', { platformUrl: `${VALID}/` }],
  ['a query', { platformUrl: `${VALID}?kb-sentinel` }],
  ['a fragment', { platformUrl: `${VALID}#kb-sentinel` }],
  ['user information', { platformUrl: 'http://kb-sentinel@172.30.0.3:8080' }],
  ['surrounding whitespace', { platformUrl: ` ${VALID}` }],
  ['a trailing line break', { platformUrl: `${VALID}\n` }],
  ['an array', [VALID]],
  ['a map', new Map([['platformUrl', VALID]])],
  [
    'a class instance',
    new (class Config {
      platformUrl = VALID;
    })(),
  ],
  ['a string config', VALID],
  ['a number config', 3],
  ['a boolean config', true],
])('rejects %s with the fixed TypeError', (_label, config) => {
  const error = rejection(config);

  expect(error).toBeInstanceOf(TypeError);
  expect(error.message).toBe(REJECTED);
  expect(error.message).not.toContain('kb-sentinel');
  expect(error.message).not.toContain('172.');
});

it('ships the fixed manifest and exactly one config-free insert row addressed by absolute path', () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const manifest = JSON.parse(read('./package.json'));

  expect(manifest).toMatchObject({
    name: '@dsh-team/knowledge-base',
    version: '0.1.0',
    private: true,
    type: 'module',
    main: 'index.js',
    engines: { dsh: '>=0.2.1-rc.2 <0.3.0' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar'] },
    },
  });
  expect(manifest.exports).toEqual({
    '.': './index.js',
    './client': './client.js',
    './package.json': './package.json',
  });
  expect(manifest.peerDependencies).toBeUndefined();
  expect(manifest.files).toEqual([
    'package.json',
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'README.md',
  ]);
  expect(parse(read('./cordis.patch.yml'))).toEqual([
    { insert: [{ id: 'knowledge-base', name: '/opt/dsh-team/knowledge-base/index.js' }] },
  ]);
});
