import { expect, it } from 'vitest';
import { extractLaunchToken, launchTokenPresent } from './index.ts';

// Released client-connection tokens are 32 random bytes in unpadded base64url: 43 characters.
const TOKEN = 'Ab_cd-12efGHij34klMNop56qrSTuv78wxYZ90ab_-Q';
const ADDRESS = '172.30.0.2';

it.each([
  `dsh web: http://172.30.0.2:3080/?token=${TOKEN}\n`,
  `boot\r\ndsh web: http://172.30.0.2:3080/?token=${TOKEN}\r\n`,
  `boot\ndsh web: http://172.30.0.2:3080/?token=${TOKEN}`,
])('recognizes the released Web announcement for the instance address', (line) => {
  expect(extractLaunchToken(line, ADDRESS)).toBe(TOKEN);
  expect(launchTokenPresent(line, ADDRESS)).toBe(true);
});

it.each([
  ['an arbitrary token-like line', `token=${TOKEN}\n`],
  ['a leading prefix', `prefix dsh web: http://172.30.0.2:3080/?token=${TOKEN}\n`],
  ['a trailing suffix', `dsh web: http://172.30.0.2:3080/?token=${TOKEN} \n`],
  ['an extra query field', `dsh web: http://172.30.0.2:3080/?token=${TOKEN}&other=true\n`],
  [
    'the 0.2.0 LAN suffix',
    `dsh web: http://172.30.0.2:3080/?token=${TOKEN} (LAN: http://172.30.0.2:3080/?token=${TOKEN})\n`,
  ],
  ['the 0.2.0 loopback announcement', `dsh web: http://127.0.0.1:3080/?token=${TOKEN}\n`],
  ['another instance address', `dsh web: http://172.30.0.18:3080/?token=${TOKEN}\n`],
  ['an address sharing the prefix', `dsh web: http://172.30.0.20:3080/?token=${TOKEN}\n`],
  ['an unescaped-dot lookalike', `dsh web: http://172x30x0x2:3080/?token=${TOKEN}\n`],
  ['a hostname', `dsh web: http://remote.invalid:3080/?token=${TOKEN}\n`],
  ['another port', `dsh web: http://172.30.0.2:3081/?token=${TOKEN}\n`],
  ['a 42-character token', `dsh web: http://172.30.0.2:3080/?token=${TOKEN.slice(1)}\n`],
  ['a 44-character token', `dsh web: http://172.30.0.2:3080/?token=${TOKEN}A\n`],
  ['a non-base64url token', `dsh web: http://172.30.0.2:3080/?token=${TOKEN.slice(1)}+\n`],
])('rejects %s', (_label, line) => {
  expect(extractLaunchToken(line, ADDRESS)).toBeUndefined();
  expect(launchTokenPresent(line, ADDRESS)).toBe(false);
});
