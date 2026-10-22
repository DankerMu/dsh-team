import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareVerificationImage } from '../../scripts/verification-image.mjs';
import type { DockerCommand } from './docker-command.ts';

const imageId = `sha256:${'a'.repeat(64)}`;
const tag = 'dsh-team-test-artifact:case';
const labels = { 'dsh-team.test-run': 'case' };
const config = {
  os: 'linux',
  architecture: 'amd64',
  config: { User: '1001', Env: ['PATH=/usr/bin'], Labels: { source: 'preserved' } },
  rootfs: { type: 'layers', diff_ids: [`sha256:${'b'.repeat(64)}`] },
};
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function inputs() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-image-input-'));
  directories.push(root);
  const blobs = join(root, 'blobs', 'sha256');
  await mkdir(blobs, { recursive: true, mode: 0o700 });
  async function blob(value: unknown) {
    const bytes = JSON.stringify(value);
    const hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(blobs, hash), bytes, { mode: 0o600 });
    return `sha256:${hash}`;
  }
  const configId = await blob(config);
  const manifestDigest = await blob({ config: { digest: configId } });
  const path = join(root, 'selection.json');
  await writeFile(
    path,
    JSON.stringify({ roles: { user: { layout: root, configId, manifestDigest } } }),
    { mode: 0o600 },
  );
  vi.stubEnv('DSH_TEAM_VERIFICATION_IMAGES', path);
  return root;
}
function inspection(changed: 'none' | 'user' | 'layers'): DockerCommand {
  return (args) => {
    if (args.at(-1) === tag)
      return { status: 1, stdout: '', stderr: `Error: No such image: ${tag}` };
    return {
      status: 0,
      stderr: '',
      stdout: JSON.stringify([
        {
          Id: imageId,
          Os: 'linux',
          Architecture: 'amd64',
          Config: {
            ...config.config,
            User: changed === 'user' ? '0' : '1001',
            Labels: { ...config.config.Labels, ...labels },
          },
          RootFS: { Type: 'layers', Layers: changed === 'layers' ? [] : config.rootfs.diff_ids },
        },
      ]),
    };
  };
}

it.each(['user', 'layers'] as const)(
  'refuses a derived image whose %s differs from the uploaded artifact',
  async (changed) => {
    const root = await inputs();
    prepareVerificationImage('user', tag, labels, root, inspection('none'))?.verify(imageId);
    const prepared = prepareVerificationImage('user', tag, labels, root, inspection(changed));

    expect(() => prepared?.verify(imageId)).toThrow(
      'Verification image artifact identity mismatch',
    );
  },
);

it('refuses an occupied case tag before granting cleanup ownership or preparing a build', async () => {
  const root = await inputs();
  const foreign: DockerCommand = () => ({ status: 0, stdout: '[]', stderr: '' });

  expect(() => prepareVerificationImage('user', tag, labels, root, foreign)).toThrow(
    'Verification image artifact input rejected',
  );
});
