import { expect, it } from 'vitest';
import { requestTarget, routerPath } from './request-path.ts';

it.each([
  ['http://host/api/%2F/../x?q=1', '/api/%2F/../x?q=1'],
  ['https://host?x=1', '/?x=1'],
  ['http://host', '/'],
  ['/raw//path', '/raw//path'],
])('preserves raw target semantics for %s', (input, expected) => {
  expect(requestTarget(input)).toBe(expected);
});

it.each([
  ['/%5Fplatform/x', '/_platform/x'],
  ['/%5fplatform/x', '/_platform/x'],
  ['/_platfor%6d/x', '/_platform/x'],
  ['/_platform%2Fx', '/_platform%2Fx'],
  ['/_platform#x', '/_platform'],
  ['/_platform#/x', '/_platform'],
  ['/%5Fplatform#x', '/_platform'],
  ['/healthz#x', '/healthz'],
  ['/x#%zz', '/x'],
  ['/x?%zz', '/x'],
  ['http://h/%5Fplatform#x', '/_platform'],
  ['HTTP://h/%5Fplatform/x', '/_platform/x'],
  ['/%C3%A9', '/é'],
])('routes %s as %s, cut at the first ? or # before decoding', (raw, expected) => {
  expect(routerPath(raw)).toBe(expected);
});

it('decodes %25 to a path that stays under the reserved prefix', () => {
  expect(routerPath('/_platform/%25')?.startsWith('/_platform/')).toBe(true);
});

it.each(['/%zz', '/%E0%A4%A', '/_platform/%C0%AF'])('has no router path for %s', (raw) => {
  expect(routerPath(raw)).toBeNull();
});
