import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  cliSubmissionCall,
  httpSubmissionCall,
  requireSubmissionCall,
  submissionCaller,
  submissionCallerFromStack,
} from '../../scripts/verification-submission-storage.mjs';

const SELF = 'submission-call-label.integration.test.ts';
const TESTS = fileURLToPath(new URL('./', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/docker-command.mjs', import.meta.url));
const limit = Error.stackTraceLimit;
const prepare = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');

afterEach(() => {
  Error.stackTraceLimit = limit;
  if (prepare === undefined) Reflect.deleteProperty(Error, 'prepareStackTrace');
  else Object.defineProperty(Error, 'prepareStackTrace', prepare);
});

function frame(location: string, name = 'fn'): string {
  return `    at ${name} (${location}:12:34)`;
}

function stack(...frames: string[]): string {
  return ['Error: ', frame(SCRIPT, 'submission'), ...frames].join('\n');
}

it.each([
  [['rm', '-f', 'dsh-team-x'], 'rm'],
  [['network', 'connect', 'n', 'c'], 'network connect'],
  [['container', 'rm', 'x'], 'container rm'],
  [['compose', '--project-directory', '.', 'up'], 'compose'],
  [['compose', 'up', '-d'], 'compose up'],
  [['buildx', 'build', '--load', '.'], 'buildx build'],
  [['image', 'rm', 'sha256:abc'], 'image rm'],
  [['volume', 'create', 'dsh-team-v'], 'volume create'],
  [['network', 'dsh-team-net'], 'network'],
  [['network', 'create'], 'network create'],
  [['exec', 'create', 'rm'], 'exec'],
  [['--context', 'remote', 'rm', 'x'], 'other'],
  [['frobnicate'], 'other'],
  [['dsh-team-x', 'rm'], 'other'],
  [[], 'other'],
])('labels CLI arguments %j as operation %s', (args, operation) => {
  expect(cliSubmissionCall(args)).toEqual({ transport: 'cli', operation, caller: SELF });
});

it.each([
  ['POST', '/containers/abc123/kill', 'POST /containers/{id}/kill'],
  ['POST', '/containers/create?name=dsh-team-x', 'POST /containers/create'],
  ['DELETE', '/networks/n1', 'DELETE /networks/{id}'],
  ['POST', '/networks/n1/connect', 'POST /networks/{id}/connect'],
  ['POST', '/networks/n1/disconnect', 'POST /networks/{id}/disconnect'],
  ['POST', '/networks/create', 'POST /networks/create'],
  ['POST', '/networks/create?checkDuplicate=true', 'POST /networks/create'],
  ['POST', '/volumes/create', 'POST /volumes/create'],
  ['DELETE', '/volumes/v1', 'DELETE /volumes/{id}'],
  ['DELETE', '/containers/dsh-team-u-1?force=true', 'DELETE /containers/{id}'],
  ['POST', '/containers/owned_c.1/stop?t=2', 'POST /containers/{id}/stop'],
  ['POST', '/containers/a1/start', 'POST /containers/{id}/start'],
  ['POST', '/create?name=a%20b', 'other'],
  ['POST', '/containers/a/b/c', 'other'],
  ['POST', '/containers/owned%2fc/kill', 'other'],
  ['POST', '/containers/../kill', 'other'],
  ['POST', '/containers/.hidden/kill', 'other'],
  ['DELETE', '/networks/', 'other'],
  ['DELETE', '/networks/owned/resource', 'other'],
  ['PUT', '/networks/create', 'other'],
  ['post', '/networks/create', 'other'],
  ['POST', '//networks/create', 'other'],
  ['POST', 'networks/create', 'other'],
])('labels HTTP %s %s as %s', (method, path, operation) => {
  expect(httpSubmissionCall(method, path)).toEqual({ transport: 'http', operation, caller: SELF });
});

it('derives a total closed label from hostile inputs', () => {
  const hostile = new Proxy<string[]>([], {
    get() {
      throw new Error('hostile argument access');
    },
  });
  expect(cliSubmissionCall(hostile)).toEqual({
    transport: 'cli',
    operation: 'other',
    caller: SELF,
  });
  expect(httpSubmissionCall('POST', undefined as unknown as string)).toEqual({
    transport: 'http',
    operation: 'other',
    caller: SELF,
  });
});

it('never carries arguments, names, identifiers, queries or paths', () => {
  const secrets = [
    'dsh-team-secret-name',
    '0123456789abcdef0123456789abcdef',
    'TOKEN=value',
    'a%20b',
    'user@example.invalid',
    '/var/run/docker.sock',
  ];
  const labels = [
    ...secrets.flatMap((secret) => [
      cliSubmissionCall(['rm', '-f', secret]),
      cliSubmissionCall(['network', 'connect', secret, secret]),
      cliSubmissionCall([secret]),
      cliSubmissionCall(['volume', secret]),
      httpSubmissionCall('POST', `/containers/${secret}/kill?name=${secret}`),
      httpSubmissionCall('DELETE', `/networks/${secret}`),
      httpSubmissionCall('POST', `/containers/create?name=${secret}`),
    ]),
  ];
  for (const label of labels) {
    const text = JSON.stringify([label.operation, label.caller]);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/dsh-team|[=%?@]|[0-9a-f]{12}/);
    expect(label.operation).toMatch(
      /^(?:other|[a-z]+(?: [a-z]+)?|[A-Z]+ (?:\/(?:[a-z]+|\{id\}))+)$/,
    );
    expect(() => {
      requireSubmissionCall(label);
    }).not.toThrow();
  }
});

it.each([
  ['a wrapper', [frame(join(TESTS, 'docker-command.ts'))], 'unknown'],
  ['the cleanup wrapper', [frame(join(TESTS, 'docker-cleanup.ts'))], 'unknown'],
  [
    'a fixture',
    [frame(join(TESTS, 'container-start-docker-fixture.ts'))],
    'container-start-docker-fixture.ts',
  ],
  [
    'a same-named file outside the repository',
    [frame('/elsewhere/platform/test/x.test.ts')],
    'unknown',
  ],
  [
    'a repository prefix inside another path',
    [frame(`/outer${join(TESTS, 'x.test.ts')}`)],
    'unknown',
  ],
  ['a nested platform test path', [frame(join(TESTS, 'nested', 'x.test.ts'))], 'unknown'],
  ['an invalid basename', [frame(join(TESTS, 'Bad_Name.test.ts'))], 'unknown'],
  ['a Python helper', [frame(join(TESTS, 'cli-pty.py'))], 'unknown'],
  [
    'an eval frame',
    ['    at eval (eval at <anonymous> ([eval1]:1:1), <anonymous>:1:1)'],
    'unknown',
  ],
  ['no frames', [], 'unknown'],
])('derives the caller from %s', (_name, frames, expected) => {
  expect(submissionCallerFromStack(stack(...frames))).toBe(expected);
  // A later issuing test file is preferred to every earlier wrapper or fixture frame.
  const test = frame(join(TESTS, 'foo.docker.test.ts'), 'async test');
  expect(submissionCallerFromStack(stack(...frames, test))).toBe('foo.docker.test.ts');
});

it('prefers the first test file over earlier fixtures and accepts plain and file URL frames', () => {
  const fixture = frame(join(TESTS, 'volumes-fixture.ts'));
  const url = pathToFileURL(join(TESTS, 'network-capacity.docker.test.ts')).href;
  expect(submissionCallerFromStack(stack(fixture, `    at ${url}:1:2`))).toBe(
    'network-capacity.docker.test.ts',
  );
  expect(
    submissionCallerFromStack(stack(`    at ${join(TESTS, 'ci-vps-worker.ts')}:3:4`, fixture)),
  ).toBe('ci-vps-worker.ts');
  expect(
    submissionCallerFromStack(stack(frame(pathToFileURL(join(TESTS, 'volumes-fixture.ts')).href))),
  ).toBe('volumes-fixture.ts');
});

it('raises the stack limit locally and restores it', () => {
  Error.stackTraceLimit = 1;
  expect(submissionCaller()).toBe(SELF);
  expect(Error.stackTraceLimit).toBe(1);
  Error.stackTraceLimit = 0;
  expect(cliSubmissionCall(['rm']).caller).toBe(SELF);
  expect(Error.stackTraceLimit).toBe(0);
});

it('falls back to unknown when the stack cannot be formatted and restores the limit', () => {
  Error.stackTraceLimit = 3;
  Error.prepareStackTrace = () => {
    throw new Error('stack formatting failed');
  };
  expect(submissionCaller()).toBe('unknown');
  expect(Error.stackTraceLimit).toBe(3);
  Error.prepareStackTrace = () => 17;
  expect(httpSubmissionCall('POST', '/networks/create')).toEqual({
    transport: 'http',
    operation: 'POST /networks/create',
    caller: 'unknown',
  });
  expect(httpSubmissionCall('POST', '/networks/create', 'volumes-fixture.ts').caller).toBe(
    'volumes-fixture.ts',
  );
  expect(Error.stackTraceLimit).toBe(3);
});

it('prefers a call-time caller over the construction-point fallback', () => {
  expect(httpSubmissionCall('POST', '/volumes/create', 'volumes-fixture.ts').caller).toBe(SELF);
});

it.each([
  { transport: 'cli', operation: 'rm', caller: 'unknown' },
  { transport: 'cli', operation: 'network connect', caller: 'foo.docker.test.ts' },
  { transport: 'cli', operation: 'other', caller: 'ci-vps-worker.ts' },
  { transport: 'http', operation: 'POST /containers/{id}/kill', caller: 'x.mjs' },
  { transport: 'http', operation: 'other', caller: 'x.mts' },
])('accepts the closed label %j', (call) => {
  expect(() => {
    requireSubmissionCall(call);
  }).not.toThrow();
});

it.each([
  null,
  'rm',
  [],
  {},
  { transport: 'cli', operation: 'rm' },
  { transport: 'cli', operation: 'rm', caller: 'unknown', extra: 1 },
  { transport: 'ssh', operation: 'rm', caller: 'unknown' },
  { transport: 'cli', operation: 'frobnicate', caller: 'unknown' },
  { transport: 'cli', operation: 'network frobnicate', caller: 'unknown' },
  { transport: 'cli', operation: 'rm -f', caller: 'unknown' },
  { transport: 'cli', operation: 'POST /networks/create', caller: 'unknown' },
  { transport: 'http', operation: 'rm', caller: 'unknown' },
  { transport: 'http', operation: 'POST /containers/abc/kill', caller: 'unknown' },
  { transport: 'http', operation: 'POST /create', caller: 'unknown' },
  { transport: 'http', operation: 'post /networks/create', caller: 'unknown' },
  { transport: 'cli', operation: 17, caller: 'unknown' },
  { transport: 'cli', operation: 'rm', caller: 17 },
  { transport: 'cli', operation: 'rm', caller: '' },
  { transport: 'cli', operation: 'rm', caller: 'Unknown' },
  { transport: 'cli', operation: 'rm', caller: 'x.py' },
  { transport: 'cli', operation: 'rm', caller: 'x.test.ts/y.ts' },
  { transport: 'cli', operation: 'rm', caller: '/abs/x.test.ts' },
  { transport: 'cli', operation: 'rm', caller: '-x.ts' },
  { transport: 'cli', operation: 'rm', caller: 'x.test.ts ' },
])('rejects the malformed label %j', (call) => {
  expect(() => {
    requireSubmissionCall(call);
  }).toThrow('Verification submission call label malformed');
});
