import type { DockerClient } from './client.ts';

/** Ensure the persistent home/work pair; failures never delete either volume. */
export async function ensureUserVolumes(
  client: DockerClient,
  userId: string,
): Promise<{ home: string; work: string }> {
  // Account identities are exactly twelve lowercase ASCII letters/digits.
  if (userId.length !== 12 || !/^[a-z0-9]{12}$/.test(userId)) {
    throw new Error('Invalid account user ID');
  }
  const home = `dsh-team-home-${userId}`;
  const work = `dsh-team-work-${userId}`;
  for (const name of [home, work]) {
    const document = await client.json('POST', '/volumes/create', {
      Name: name,
      Labels: { 'dsh-team.user': userId },
    });
    if (
      typeof document !== 'object' ||
      document === null ||
      !('Name' in document) ||
      document.Name !== name
    ) {
      throw new Error(`Invalid Docker volume response for ${name}`);
    }
    if (
      !('Labels' in document) ||
      typeof document.Labels !== 'object' ||
      document.Labels === null ||
      Array.isArray(document.Labels) ||
      !('dsh-team.user' in document.Labels) ||
      document.Labels['dsh-team.user'] !== userId
    ) {
      throw new Error(`Docker volume ownership mismatch for ${name}`);
    }
  }
  return { home, work };
}
