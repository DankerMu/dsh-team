import { expect, it } from 'vitest';
import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { requireAbsent } from './home-helper.ts';

it.each([200, 403, 500])('does not treat Docker status %s as container absence', async (status) => {
  const client: DockerClient = {
    json: () =>
      status === 200 ? Promise.resolve({}) : Promise.reject(new DockerHttpError(status)),
    async *logs() {
      yield await Promise.resolve({ stream: 'stdout' as const, data: Buffer.alloc(0) });
    },
  };

  await expect(requireAbsent(client, 'owned')).rejects.toThrow();
});
