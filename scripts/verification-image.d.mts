import type { DockerCommand } from '../platform/test/docker-command.ts';

export declare function prepareVerificationImage(
  role: 'user' | 'platform' | 'browser',
  tag: string,
  labels: Readonly<Record<string, string>>,
  directory: string,
  command: DockerCommand,
): { readonly args: string[]; verify(imageId: string): void } | undefined;
