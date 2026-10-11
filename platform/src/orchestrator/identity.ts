export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Docker startup response');
  }
  // Boundary JSON is unknown; every field is checked by its consumer below.
  return value as Record<string, unknown>;
}

export function containerId(value: unknown): string {
  const id = object(value).Id;
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) {
    throw new Error('Invalid Docker container identity');
  }
  return id;
}

export function ownedContainer(
  value: unknown,
  name: string,
  userId: string,
  imageId: string,
): Record<string, unknown> {
  const row = object(value);
  const config = object(row.Config);
  if (
    row.Name !== `/${name}` ||
    row.Image !== imageId ||
    object(config.Labels)['dsh-team.user'] !== userId
  ) {
    throw new Error('Docker container ownership mismatch');
  }
  containerId(row);
  return row;
}

export function resolvedImageId(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('Invalid Docker image identity');
  }
  return value;
}

/** Terminal stopped/error indexes have no runtime container to retire or reuse. */
export function isTerminalInstance(status: unknown, container: unknown): boolean {
  return (status === 'stopped' || status === 'error') && container === null;
}

/** Verified absent indexed identity; the caller owns exact404 and current snapshot validation. */
export interface AbsentInstanceIdentity {
  readonly containerId: string;
  readonly startedAt: number | null;
  readonly status: 'starting' | 'running' | 'stopped' | 'error';
}

export function absentInstanceIdentity(
  instance: Record<string, unknown>,
  id: string,
): AbsentInstanceIdentity {
  if (typeof instance.last_started_at !== 'number' && instance.last_started_at !== null)
    throw new Error('Invalid indexed start identity');
  if (
    instance.status !== 'starting' &&
    instance.status !== 'running' &&
    instance.status !== 'stopped' &&
    instance.status !== 'error'
  )
    throw new Error('Invalid indexed instance status');
  return { containerId: id, startedAt: instance.last_started_at, status: instance.status };
}
