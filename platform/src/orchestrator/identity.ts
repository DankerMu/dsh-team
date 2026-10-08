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

export function resolvedImageId(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('Invalid Docker image identity');
  }
  return value;
}
