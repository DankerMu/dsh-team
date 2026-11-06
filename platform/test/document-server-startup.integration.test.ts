import { describe, expect, it } from 'vitest';
import { observeStartup } from './main-startup-fixture.ts';

const CONTAINER_NAME = 'DOCUMENT_SERVER_CONTAINER_NAME';
const JWT_SECRET = 'DOCUMENT_SERVER_JWT_SECRET';
const NAME_MARKER = 'name-marker-5d2f';
const JWT_MARKER = 'jwt-marker-c83a';

describe('Document Server configuration in the actual source process', () => {
  it.each([
    ['only the container name', { [CONTAINER_NAME]: NAME_MARKER }, [JWT_SECRET]],
    ['only the JWT', { [JWT_SECRET]: JWT_MARKER }, [CONTAINER_NAME]],
    [
      'an empty container name',
      { [CONTAINER_NAME]: '', [JWT_SECRET]: JWT_MARKER },
      [CONTAINER_NAME],
    ],
    ['an empty JWT', { [CONTAINER_NAME]: NAME_MARKER, [JWT_SECRET]: '' }, [JWT_SECRET]],
    ['both inputs empty', { [CONTAINER_NAME]: '', [JWT_SECRET]: '' }, [CONTAINER_NAME, JWT_SECRET]],
  ] as const)(
    'rejects %s before serving health without echoing values',
    async (_, environment, named) => {
      const result = await observeStartup(undefined, undefined, environment);

      expect(result.health).toBeNull();
      expect(result.exitCode, JSON.stringify(result)).toBeGreaterThan(0);
      for (const name of named) expect(result.stderr).toContain(name);
      expect(result.stderr).not.toContain(NAME_MARKER);
      expect(result.stderr).not.toContain(JWT_MARKER);
    },
    10000,
  );

  it.each([
    ['both inputs absent', {}],
    [
      'both inputs nonempty',
      { [CONTAINER_NAME]: 'dsh-team-documentserver', [JWT_SECRET]: JWT_MARKER },
    ],
  ] as const)(
    'serves health when %s',
    async (_, environment) => {
      const result = await observeStartup(undefined, undefined, environment);

      expect(result.exitCode).toBeNull();
      expect(result.health).toEqual({ status: 200, body: { status: 'ok' } });
      expect(result.stderr).toBe('');
    },
    10000,
  );
});
