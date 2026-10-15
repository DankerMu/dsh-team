import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { containerId, object, ownedContainer } from './identity.ts';

export async function requireAbsent(client: DockerClient, name: string): Promise<void> {
  try {
    await client.json('GET', `/containers/${name}/json`);
  } catch (error) {
    if (error instanceof DockerHttpError && error.statusCode === 404) return;
    throw error;
  }
  throw new Error('Canonical user container already exists');
}

export async function readSeccompPolicy(path: string, signal: AbortSignal): Promise<string> {
  const policy = object(JSON.parse(await readFile(path, { encoding: 'utf8', signal })));
  if (
    typeof policy.defaultAction !== 'string' ||
    !/^SCMP_ACT_[A-Z_]+$/.test(policy.defaultAction) ||
    !Array.isArray(policy.syscalls)
  )
    throw new Error('Invalid seccomp policy');
  return JSON.stringify(policy);
}

export class HomeHelperUnconfirmedError extends AggregateError {}

interface HomeHelperInput {
  readonly client: DockerClient;
  readonly cleanupClient: DockerClient;
  readonly userId: string;
  readonly home: string;
  readonly imageId: string;
  readonly seccomp: string;
  readonly role: 'managed-composition' | 'profile-reset';
  readonly beforeStart?: (helper: Record<string, unknown>) => Promise<void>;
}

function assertHelperIdentity(
  row: Record<string, unknown>,
  role: HomeHelperInput['role'],
  invocation: string,
  id?: string,
): void {
  const labels = object(object(row.Config).Labels);
  if (
    labels['dsh-team.role'] !== role ||
    labels['dsh-team.invocation'] !== invocation ||
    (id !== undefined && row.Id !== id)
  )
    throw new Error('Home helper ownership mismatch');
}

/** A single exact-invocation lifecycle for operations on an existing home volume. */
export async function runHomeHelper<Result>(
  input: HomeHelperInput,
  consume: (run: (script: string) => Promise<string>) => Promise<Result>,
): Promise<Result> {
  const { client, cleanupClient, userId, home, imageId, seccomp, role } = input;
  const invocation = randomUUID();
  const name = `dsh-team-${role === 'managed-composition' ? 'compose' : 'restore'}-${userId}-${invocation}`;
  const label = role === 'managed-composition' ? 'Managed composition' : 'Profile restoration';
  const labels = {
    'dsh-team.user': userId,
    'dsh-team.role': role,
    'dsh-team.invocation': invocation,
  };
  let attempted = false;
  let unconfirmed = false;
  let id: string | undefined;
  let result: Result | undefined;
  const failures: Error[] = [];
  try {
    await requireAbsent(client, name);
    attempted = true;
    result = await consume(async (script) => {
      unconfirmed = true;
      try {
        id = containerId(
          await client.json('POST', `/containers/create?name=${name}`, {
            Image: imageId,
            User: '1001',
            Env: ['DSH_HOME=/data/home', 'DSH_TELEMETRY_DISABLED=1'],
            Cmd: ['node', '--input-type=module', '-e', script],
            Labels: labels,
            HostConfig: {
              NetworkMode: 'none',
              Privileged: false,
              CapAdd: [],
              SecurityOpt: [`seccomp=${seccomp}`],
              Mounts: [
                {
                  Type: 'volume',
                  Source: home,
                  Target: '/data/home',
                  VolumeOptions: { NoCopy: role === 'profile-reset' },
                },
              ],
            },
          }),
        );
        unconfirmed = false;
      } catch (error) {
        if (error instanceof DockerHttpError) unconfirmed = false;
        throw error;
      }
      const helper = ownedContainer(
        await client.json('GET', `/containers/${id}/json`),
        name,
        userId,
        imageId,
      );
      assertHelperIdentity(helper, role, invocation, id);
      await input.beforeStart?.(helper);
      await client.json('POST', `/containers/${id}/start`);
      const exit = object(
        await client.json('POST', `/containers/${id}/wait?condition=not-running`),
      );
      if (exit.StatusCode !== 0 || (exit.Error !== undefined && exit.Error !== null))
        throw new Error('Home helper failed');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of client.logs(`/containers/${id}/logs?stdout=1&stderr=1`)) {
        size += chunk.data.length;
        if (size > 1024 * 1024) throw new Error('Home helper output limit exceeded');
        if (chunk.stream === 'stdout') chunks.push(chunk.data);
      }
      return Buffer.concat(chunks).toString('utf8');
    });
  } catch {
    failures.push(new Error(`${label} failed`));
  }
  if (attempted) {
    try {
      let found: unknown;
      try {
        found = await cleanupClient.json('GET', `/containers/${name}/json`);
      } catch (error) {
        if (!(error instanceof DockerHttpError && error.statusCode === 404)) throw error;
      }
      if (found !== undefined) {
        const row = ownedContainer(found, name, userId, imageId);
        assertHelperIdentity(row, role, invocation, id);
        const actualId = containerId(row);
        await cleanupClient.json('DELETE', `/containers/${actualId}?force=true`);
        unconfirmed = false;
      }
    } catch {
      unconfirmed = true;
      failures.push(new Error(`${label} cleanup failed`));
    }
  }
  if (unconfirmed) throw new HomeHelperUnconfirmedError(failures, `${label} cleanup unconfirmed`);
  if (failures.length > 0)
    throw new AggregateError(failures, failures.map((error) => error.message).join('; '));
  if (result === undefined) throw new Error(`${label} missing`);
  return result;
}
