import { expect, it } from 'vitest';
import { isPlainObject } from './plain-object.ts';

const NULL_PROTOTYPE: unknown = Object.create(null);

it.each([
  ['an object literal', { a: 1 }],
  ['a null-prototype object', NULL_PROTOTYPE],
])('accepts %s', (_label, value) => {
  const result = isPlainObject(value);

  expect(result).toBe(true);
});

it.each([
  ['null', null],
  ['an array', []],
  ['a string', 'x'],
  ['a number', 1],
  ['undefined', undefined],
  ['a function', () => undefined],
])('rejects %s', (_label, value) => {
  const result = isPlainObject(value);

  expect(result).toBe(false);
});
