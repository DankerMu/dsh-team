import { expect, it } from 'vitest';
import { hasCodePointLength } from './unicode.ts';

it.each([
  ['a', 1],
  ['\ud800', 1],
  ['\udc00', 1],
  ['\ud800x', 2],
  ['\udc00\ud800', 2],
  ['\ud800\udc00', 1],
  ['\u{10000}', 1],
  ['\0', 1],
] as const)(
  'counts surrogate pairs, isolated units and NUL consistently for %j',
  (value, count) => {
    expect(hasCodePointLength(value, count, count)).toBe(true);
    expect(hasCodePointLength(value, 0, count - 1)).toBe(false);
    expect(hasCodePointLength(value, count + 1, count + 2)).toBe(false);
  },
);

it('accepts empty text only when the minimum allows it', () => {
  expect(hasCodePointLength('', 0, 254)).toBe(true);
  expect(hasCodePointLength('', 6, 256)).toBe(false);
});
