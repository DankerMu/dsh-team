/**
 * Adapted from resource/dsh-team-hub/src/passwords.mjs.
 *
 * MIT License
 *
 * Copyright (c) 2026 dsh-team-hub contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_LEN = 64;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_OPTIONS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
const ENCODED_PREFIX = `scrypt-utf16le$${String(SCRYPT_N)}$${String(SCRYPT_R)}$${String(SCRYPT_P)}$${String(KEY_LEN)}$`;
const SALT_HEX_LENGTH = SALT_BYTES * 2;
const HASH_HEX_LENGTH = KEY_LEN * 2;
const ENCODED_LENGTH = ENCODED_PREFIX.length + SALT_HEX_LENGTH + 1 + HASH_HEX_LENGTH;
const ENCODED_RECORD = /^scrypt-utf16le\$16384\$8\$1\$64\$([0-9a-f]{32})\$([0-9a-f]{128})$/;
const MIN_PASSWORD_CODE_POINTS = 6;
const MAX_PASSWORD_CODE_POINTS = 256;
const INVALID_PASSWORD_LENGTH = 'Password must be 6 to 256 Unicode code points';

export class PasswordPolicyError extends Error {
  constructor() {
    super(INVALID_PASSWORD_LENGTH);
  }
}

function hasBoundedUnicodeCodePoints(password: string): boolean {
  let count = 0;
  for (let index = 0; index < password.length;) {
    count += 1;
    if (count > MAX_PASSWORD_CODE_POINTS) {
      return false;
    }
    const unit = password.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = password.charCodeAt(index + 1);
      index += next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
    } else {
      index += 1;
    }
  }
  return count >= MIN_PASSWORD_CODE_POINTS;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // UTF-16LE is required so lone surrogates keep distinct identities; Node's default UTF-8 conversion aliases each of them to U+FFFD.
    scrypt(Buffer.from(password, 'utf16le'), salt, KEY_LEN, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (!hasBoundedUnicodeCodePoints(password)) {
    throw new PasswordPolicyError();
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await deriveKey(password, salt);
  return `${ENCODED_PREFIX}${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!hasBoundedUnicodeCodePoints(password) || encoded.length !== ENCODED_LENGTH) {
    return false;
  }
  const match = ENCODED_RECORD.exec(encoded);
  const saltHex = match?.[1];
  const expectedHex = match?.[2];
  if (saltHex === undefined || expectedHex === undefined) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, expected);
}
