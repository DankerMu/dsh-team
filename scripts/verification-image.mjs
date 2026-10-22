import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isAbsentResource } from '../platform/test/docker-command.ts';

const digest = /^sha256:[a-f0-9]{64}$/;
function jsonFile(path, maximum, expectedDigest) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.uid !== process.getuid() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.size > maximum
    )
      throw new Error('Invalid image input');
    const bytes = Buffer.alloc(before.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('Changed image input');
    const content = bytes.subarray(0, count);
    if (
      expectedDigest &&
      `sha256:${createHash('sha256').update(content).digest('hex')}` !== expectedDigest
    )
      throw new Error('Changed image digest');
    return JSON.parse(content.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

function readArtifactInput(role, selected) {
  if (!selected) throw new Error('Missing image selection');
  const entry = jsonFile(selected, 16384).roles?.[role];
  if (
    !entry ||
    !isAbsolute(entry.layout) ||
    !digest.test(entry.manifestDigest) ||
    !digest.test(entry.configId)
  )
    throw new Error('Invalid image selection');
  const blob = (id) => join(entry.layout, 'blobs', 'sha256', id.slice(7));
  const manifest = jsonFile(blob(entry.manifestDigest), 262144, entry.manifestDigest);
  if (manifest.config?.digest !== entry.configId) throw new Error('Image config mismatch');
  const config = jsonFile(blob(entry.configId), 262144, entry.configId);
  if (
    config.os !== 'linux' ||
    config.architecture !== 'amd64' ||
    config.rootfs?.type !== 'layers' ||
    !Array.isArray(config.rootfs.diff_ids) ||
    !config.rootfs.diff_ids.every((id) => digest.test(id))
  )
    throw new Error('Image platform mismatch');
  return { entry, config };
}

/** Trusted operator-prepared OCI inputs; native builders and their process ownership stay unchanged. */
export function prepareVerificationImage(role, tag, labels, directory, command) {
  const selected = process.env.DSH_TEAM_VERIFICATION_IMAGES;
  if (selected === undefined) return undefined;
  try {
    const { entry, config } = readArtifactInput(role, selected);
    if (!isAbsentResource(command(['image', 'inspect', tag], 30000), 'image', tag))
      throw new Error('Image target already exists');
    const context = mkdtempSync(join(directory, 'image-artifact-'));
    writeFileSync(join(context, 'Dockerfile'), 'FROM base\n', { mode: 0o600 });
    const args = [
      'build',
      '--platform',
      'linux/amd64',
      '--network=none',
      '--pull=false',
      '--build-context',
      `base=oci-layout://${entry.layout}@${entry.manifestDigest}`,
      ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      '--tag',
      tag,
      context,
    ];
    return {
      args,
      verify(imageId) {
        try {
          const result = command(['image', 'inspect', imageId], 30000);
          if (result.error || result.status !== 0) throw new Error('Image inspection failed');
          const image = JSON.parse(result.stdout)[0];
          if (
            image.Id !== imageId ||
            image.Os !== 'linux' ||
            image.Architecture !== 'amd64' ||
            !isDeepStrictEqual(image.RootFS, {
              Type: config.rootfs.type,
              Layers: config.rootfs.diff_ids,
            }) ||
            !isDeepStrictEqual(image.Config, {
              ...config.config,
              Labels: { ...config.config.Labels, ...labels },
            })
          )
            throw new Error('Image contents changed');
        } catch {
          throw new Error('Verification image artifact identity mismatch');
        }
      },
    };
  } catch {
    throw new Error('Verification image artifact input rejected');
  }
}

// The existing shell probes use the same adapter; this is not a bundle producer or runtime supervisor.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [role, tag, owner, directory, budget] = process.argv.slice(2);
  const { createDockerCommands } = await import('../platform/test/docker-command.ts');
  const { cleanupTargets, output, OWNER_LABEL, registerCleanupTarget } =
    await import('../platform/test/docker-cleanup.ts');
  const targets = [];
  const failures = [];
  let command;
  try {
    if (
      role !== 'user' ||
      !tag?.startsWith('dsh-team-') ||
      !owner ||
      !isAbsolute(directory) ||
      !/^(0|[1-9][0-9]*)$/.test(budget)
    )
      throw new Error('Invalid image acquisition arguments');
    const timeout = Number(budget);
    if (!Number.isSafeInteger(timeout)) throw new Error('Invalid image acquisition budget');
    ({ command } = createDockerCommands(
      fileURLToPath(new URL('../', import.meta.url)),
      join(directory, 'docker'),
      false,
    ));
    const prepared = prepareVerificationImage(
      role,
      tag,
      { [OWNER_LABEL]: owner },
      directory,
      command,
    );
    if (!prepared) throw new Error('Artifact selection required');
    registerCleanupTarget(targets, owner, { kind: 'image', name: tag });
    output(command(prepared.args, timeout), prepared.args);
    const inspect = ['image', 'inspect', '--format', '{{.Id}}', tag];
    const id = output(command(inspect, 30000), inspect).trim();
    prepared.verify(id);
  } catch {
    if (command) cleanupTargets(command, targets, owner, failures);
    process.stderr.write('Verification image artifact acquisition failed\n');
    process.exitCode = 1;
  }
}
