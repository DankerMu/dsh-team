import { expect, it } from 'vitest';
import { extractLaunchToken, launchTokenPresent } from './index.ts';

it.each([
  'dsh web: http://127.0.0.1:3080/?token=Ab_cd-12\n',
  'boot\r\ndsh web: http://127.0.0.1:3080/?token=Ab_cd-12\r\n',
  'dsh web: http://127.0.0.1:3080/?token=Ab_cd-12 (LAN: http://192.0.2.1:3080/?token=Ab_cd-12)\n',
])('recognizes the exact released Web announcement', (line) => {
  expect(extractLaunchToken(line)).toBe('Ab_cd-12');
  expect(launchTokenPresent(line)).toBe(true);
});

it.each([
  'token=Ab_cd-12',
  'prefix dsh web: http://127.0.0.1:3080/?token=Ab_cd-12\n',
  'dsh web: http://remote.invalid:3080/?token=Ab_cd-12\n',
  'dsh web: http://127.0.0.1:3080/?token=Ab_cd-12&other=true\n',
])('does not treat arbitrary token-like logs as a released announcement', (line) => {
  expect(extractLaunchToken(line)).toBeUndefined();
  expect(launchTokenPresent(line)).toBe(false);
});
