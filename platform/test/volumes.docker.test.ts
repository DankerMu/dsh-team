import { randomBytes } from 'node:crypto';
import { arch, platform } from 'node:os';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import {
  createDockerClient,
  DockerHttpError,
  ensureUserVolumes,
} from '../src/orchestrator/index.ts';

it('reuses one user pair and keeps four independently owned volumes for two users', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const client = createDockerClient(
    loadConfig({ PLATFORM_PUBLIC_URL: 'http://127.0.0.1' }).dockerSocketPath,
  );
  const invocation = randomBytes(5).toString('hex');
  const users = [`${invocation}00`, `${invocation}01`];
  // Register all exact targets before any potentially partial create. Unique account
  // labels are this invocation's ownership; no production test-label option is needed.
  const targets = users.flatMap((userId) => [
    { name: `dsh-team-home-${userId}`, userId },
    { name: `dsh-team-work-${userId}`, userId },
  ]);
  const attemptedUsers = new Set<string>();
  const failures: unknown[] = [];

  function assertOwned(document: unknown, name: string, userId: string): void {
    if (
      typeof document !== 'object' ||
      document === null ||
      !('Name' in document) ||
      document.Name !== name ||
      !('Labels' in document) ||
      typeof document.Labels !== 'object' ||
      document.Labels === null ||
      !('dsh-team.user' in document.Labels) ||
      document.Labels['dsh-team.user'] !== userId
    ) {
      throw new Error(
        `Refusing volume acceptance/cleanup of ${name}: invocation ownership mismatch`,
      );
    }
  }

  try {
    // A collision must fail before granting cleanup authority over any target.
    for (const { name } of targets) {
      await expect(client.json('GET', `/volumes/${name}`)).rejects.toMatchObject({
        statusCode: 404,
      });
    }
    const results = [];
    for (const userId of users) {
      attemptedUsers.add(userId);
      const pair = await ensureUserVolumes(client, userId);
      expect(pair).toEqual({ home: `dsh-team-home-${userId}`, work: `dsh-team-work-${userId}` });
      expect(await ensureUserVolumes(client, userId)).toEqual(pair);
      results.push(pair.home, pair.work);
    }
    expect(new Set(results).size).toBe(4);
    for (const { name, userId } of targets) {
      assertOwned(await client.json('GET', `/volumes/${name}`), name, userId);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    for (const { name, userId } of targets.toReversed()) {
      if (!attemptedUsers.has(userId)) continue;
      try {
        let document: unknown;
        try {
          document = await client.json(
            'GET',
            `/volumes/${name}`,
            undefined,
            AbortSignal.timeout(10_000),
          );
        } catch (error) {
          if (error instanceof DockerHttpError && error.statusCode === 404) continue;
          failures.push(new Error(`Cleanup failed for ${name}`, { cause: error }));
          continue;
        }
        assertOwned(document, name, userId);
        await client.json('DELETE', `/volumes/${name}`, undefined, AbortSignal.timeout(10_000));
        await expect(
          client.json('GET', `/volumes/${name}`, undefined, AbortSignal.timeout(10_000)),
        ).rejects.toMatchObject({ statusCode: 404 });
      } catch (error) {
        failures.push(new Error(`Cleanup failed for ${name}`, { cause: error }));
      }
    }
  }
  if (failures.length !== 0) {
    throw new AggregateError(failures, 'User volume acceptance or exact-owned cleanup failed');
  }
});
