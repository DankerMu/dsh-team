import { scrypt as scryptCallback } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './index.ts';

const ENCODED_HASH = /^scrypt-utf16le\$16384\$8\$1\$64\$[0-9a-f]{32}\$[0-9a-f]{128}$/;
const ENCODED_PREFIX = 'scrypt-utf16le$16384$8$1$64$';
const SALT_HEX = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SALT = Buffer.from(SALT_HEX, 'hex');
const KEY_LEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const ASTRAL = '😀';
const VALID_ASCII = 'passw0';
const SPACED = ` ${VALID_ASCII} `;
const COMPOSED = 'café12';
const DECOMPOSED = 'cafe\u030112';
const SIX_ASTRAL = ASTRAL.repeat(6);
const TWO_FIFTY_SIX_ASCII = 'z'.repeat(256);
const TWO_FIFTY_SIX_ASTRAL = ASTRAL.repeat(256);
const INVALID_PASSWORDS = [
  ['5 ASCII', '12345'],
  ['257 ASCII', 'z'.repeat(257)],
  ['5 Unicode code points', ASTRAL.repeat(5)],
  ['257 Unicode code points', ASTRAL.repeat(257)],
] as const;
const SURROGATE_PASSWORDS = [
  ['lone high surrogate U+D800', 'abcde\uD800'],
  ['lone high surrogate U+D801', 'abcde\uD801'],
  ['lone low surrogate U+DC00', 'abcde\uDC00'],
  ['lone low surrogate U+DC01', 'abcde\uDC01'],
  ['literal U+FFFD', 'abcde\uFFFD'],
] as const;

function deriveKey(password: string): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scryptCallback(
    Buffer.from(password, 'utf16le'),
    SALT,
    KEY_LEN,
    SCRYPT_OPTIONS,
    (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    },
  );
  return promise;
}

async function matchingRecord(password: string): Promise<string> {
  const hash = await deriveKey(password);
  return `${ENCODED_PREFIX}${SALT_HEX}$${hash.toString('hex')}`;
}

function isError(value: unknown): value is Error {
  return value instanceof Error;
}

async function hashRejection(password: string): Promise<Error> {
  try {
    await hashPassword(password);
  } catch (error) {
    if (isError(error)) {
      return error;
    }
  }
  throw new Error('expected hashPassword to reject');
}

describe('hashPassword and verifyPassword', () => {
  let validEncoded: string;

  beforeAll(async () => {
    validEncoded = await hashPassword(VALID_ASCII);
  });

  it('hashes the same valid password twice with distinct encoded records that both verify', async () => {
    const password = '123456';
    const wrongPassword = '123457';

    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).not.toBe(second);
    expect(first).toMatch(ENCODED_HASH);
    expect(second).toMatch(ENCODED_HASH);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword(password, second)).resolves.toBe(true);
    await expect(verifyPassword(wrongPassword, first)).resolves.toBe(false);
  });

  it('rejects hashing 5 and 257 ASCII and Unicode code points with one constant rule error and no plaintext echo', async () => {
    const messages: string[] = [];
    for (const [, password] of INVALID_PASSWORDS) {
      const error = await hashRejection(password);
      expect(error.message).not.toContain(password);
      messages.push(error.message);
    }

    expect(new Set(messages).size).toBe(1);
  });

  it.each([...INVALID_PASSWORDS])(
    'rejects verifying %s against a matching record',
    async (_label, password) => {
      const encoded = await matchingRecord(password);

      expect(encoded).toMatch(ENCODED_HASH);
      await expect(verifyPassword(password, encoded)).resolves.toBe(false);
    },
  );

  it.each([
    ['6 ASCII', VALID_ASCII],
    ['256 ASCII', TWO_FIFTY_SIX_ASCII],
    ['6 astral code points', SIX_ASTRAL],
    ['256 astral code points', TWO_FIFTY_SIX_ASTRAL],
  ])('accepts hashing and verifying %s', async (_label, password) => {
    const encoded = await hashPassword(password);

    expect(encoded).toMatch(ENCODED_HASH);
    expect(encoded).not.toContain(password);
    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
  });

  it('treats leading and trailing spaces as part of the password', async () => {
    const trimmedEncoded = await hashPassword(VALID_ASCII);
    const spacedEncoded = await hashPassword(SPACED);

    expect(trimmedEncoded).toMatch(ENCODED_HASH);
    expect(spacedEncoded).toMatch(ENCODED_HASH);
    await expect(verifyPassword(VALID_ASCII, trimmedEncoded)).resolves.toBe(true);
    await expect(verifyPassword(SPACED, spacedEncoded)).resolves.toBe(true);
    await expect(verifyPassword(SPACED, trimmedEncoded)).resolves.toBe(false);
    await expect(verifyPassword(VALID_ASCII, spacedEncoded)).resolves.toBe(false);
  });

  it('treats composed and decomposed Unicode as distinct passwords', async () => {
    const composedEncoded = await hashPassword(COMPOSED);
    const decomposedEncoded = await hashPassword(DECOMPOSED);

    expect(composedEncoded).toMatch(ENCODED_HASH);
    expect(decomposedEncoded).toMatch(ENCODED_HASH);
    await expect(verifyPassword(COMPOSED, composedEncoded)).resolves.toBe(true);
    await expect(verifyPassword(DECOMPOSED, decomposedEncoded)).resolves.toBe(true);
    await expect(verifyPassword(DECOMPOSED, composedEncoded)).resolves.toBe(false);
    await expect(verifyPassword(COMPOSED, decomposedEncoded)).resolves.toBe(false);
  });

  it('counts an unpaired high surrogate as one code point among six', async () => {
    const password = `abcde\uD800`;
    const encoded = await hashPassword(password);

    expect(encoded).toMatch(ENCODED_HASH);
    expect(encoded).not.toContain(password);
    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
  });

  it('counts a high surrogate followed by a non-low unit as two code points', async () => {
    const password = `abcd\uD800e`;
    const encoded = await hashPassword(password);

    expect(encoded).toMatch(ENCODED_HASH);
    expect(encoded).not.toContain(password);
    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
  });

  it('does not cross-authenticate distinct lone surrogates and literal U+FFFD', async () => {
    const encodedBySource = await Promise.all(
      SURROGATE_PASSWORDS.map(
        async ([, password]) => [password, await hashPassword(password)] as const,
      ),
    );

    for (const [sourcePassword, encoded] of encodedBySource) {
      for (const [, candidate] of SURROGATE_PASSWORDS) {
        await expect(verifyPassword(candidate, encoded)).resolves.toBe(
          candidate === sourcePassword,
        );
      }
    }
  });

  it('verifies an independently derived UTF-16LE record and rejects a wrong password', async () => {
    const encoded = await matchingRecord(VALID_ASCII);

    await expect(verifyPassword(VALID_ASCII, encoded)).resolves.toBe(true);
    await expect(verifyPassword('passw1', encoded)).resolves.toBe(false);
  });

  it.each([
    ['empty', () => ''],
    ['truncated', (encoded: string) => encoded.slice(0, encoded.length - 1)],
    [
      'nonhex',
      (encoded: string) =>
        `${encoded.slice(0, ENCODED_PREFIX.length)}gggggggggggggggggggggggggggggggg${encoded.slice(ENCODED_PREFIX.length + SALT_HEX.length)}`,
    ],
    [
      'uppercase hex',
      (encoded: string) => `${ENCODED_PREFIX}${encoded.slice(ENCODED_PREFIX.length).toUpperCase()}`,
    ],
    ['algorithm', (encoded: string) => `pbkdf2${encoded.slice(encoded.indexOf('$'))}`],
    ['old prefix', (encoded: string) => `scrypt${encoded.slice(encoded.indexOf('$'))}`],
    ['N', (encoded: string) => encoded.replace('$16384$', '$32768$')],
    ['r', (encoded: string) => encoded.replace('$8$', '$7$')],
    ['p', (encoded: string) => encoded.replace('$1$', '$2$')],
    ['keylen', (encoded: string) => encoded.replace('$64$', '$32$')],
  ] as const)(
    'rejects a %s encoded record without verifying the password',
    async (_label, mutate) => {
      const encoded = mutate(validEncoded);

      await expect(verifyPassword(VALID_ASCII, encoded)).resolves.toBe(false);
    },
  );
});
