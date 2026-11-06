import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { waitForDeployment } from './deployment-account-fixture.ts';
import { writeComposeConfiguration } from './deployment-compose-fixture.ts';
import { withDeployment } from './deployment-fixture.ts';
import { output, OWNER_LABEL } from './docker-cleanup.ts';
import { isAbsentResource } from './docker-command.ts';
import { unusedPort } from './gateway-http-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const PLATFORM = 'dsh-team-platform';
const DOCUMENT_SERVER = 'dsh-team-documentserver';
const JWT = 'DOCUMENT_SERVER_JWT_SECRET';
const FONTS = '/usr/share/fonts/truetype/custom';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** `Config.Env` never reaches a matcher: only booleans, the literal name and SHA-256 digests do. */
function environmentFacts(container: Record<string, unknown>) {
  const env: unknown = record(container.Config).Env;
  if (!Array.isArray(env) || !env.every((entry) => typeof entry === 'string'))
    throw new Error('Container environment unavailable');
  const values = new Map<string, string>();
  for (const entry of env) {
    const separator = entry.indexOf('=');
    if (separator > 0) values.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  const digest = (name: string) => {
    const value = values.get(name);
    return value === undefined ? null : sha256(value);
  };
  return {
    jwtEnabled: values.get('JWT_ENABLED') === 'true',
    allowPrivate: values.get('ALLOW_PRIVATE_IP_ADDRESS') === 'true',
    containerName: values.get('DOCUMENT_SERVER_CONTAINER_NAME') ?? null,
    jwtSha256: digest('JWT_SECRET'),
    platformJwtSha256: digest(JWT),
  };
}

it('starts the bundled Document Server stand-in unpublished, with the fixture JWT reaching it and the platform', async () => {
  await withDeployment(async (lifecycle, start) => {
    const deployment = await start();
    // The platform does not read either value yet: its health is unchanged.
    await waitForDeployment(deployment);
    const expected = sha256(deployment.documentServerJwt);

    const server = await inspectAsync(lifecycle, DOCUMENT_SERVER);
    expect(server.Name).toBe(`/${DOCUMENT_SERVER}`);
    expect(record(server.State).Running).toBe(true);
    expect(record(record(server.Config).Labels)[OWNER_LABEL]).toBe(lifecycle.runId);
    expect(record(record(server.HostConfig).PortBindings ?? {})).toEqual({});
    // Image EXPOSE entries with null bindings are not published host ports.
    for (const binding of Object.values(record(record(server.NetworkSettings).Ports ?? {})))
      expect(binding, 'Document Server effective publication').toBeNull();
    const mounts: unknown = server.Mounts;
    if (!Array.isArray(mounts)) throw new Error('Document Server mounts unavailable');
    expect(
      (mounts as unknown[])
        .map((mount) => record(mount))
        .filter((mount) => mount.Destination === FONTS)
        .map(({ Destination, RW }) => ({ Destination, RW })),
    ).toEqual([{ Destination: FONTS, RW: false }]);
    expect(environmentFacts(server)).toMatchObject({
      jwtEnabled: true,
      allowPrivate: true,
      jwtSha256: expected,
    });

    const platform = await inspectAsync(lifecycle, PLATFORM);
    expect(environmentFacts(platform)).toMatchObject({
      containerName: DOCUMENT_SERVER,
      platformJwtSha256: expected,
    });
  });
});

/** The same fixed-name admission the deployment fixture performs, in the same order. */
async function admitFixedNames(lifecycle: UserImageLifecycle) {
  for (const name of [PLATFORM, DOCUMENT_SERVER]) {
    const existing = await lifecycle.commandAsync(['container', 'inspect', name], 30_000);
    if (!isAbsentResource(existing, 'container', name))
      throw new Error(`${name} already exists or absence is unproven; refusing rejection case`);
  }
}

it('fails compose before creating any container when the JWT is unset or empty', async () => {
  await withDeployment(async (lifecycle) => {
    const { runId } = lifecycle;
    const ownership = { [OWNER_LABEL]: runId };
    const project = `dsh-team-test-${runId}`;
    const network = `${project}_default`;
    await admitFixedNames(lifecycle);
    for (const [kind, name] of [
      ['container', PLATFORM],
      ['container', DOCUMENT_SERVER],
      ['network', network],
    ] as const)
      await lifecycle.registerResourceAsync(kind, name, ownership);
    const root = dirname(lifecycle.overlayDirectory);
    const dockerGid = (await stat('/var/run/docker.sock')).gid;

    for (const mode of ['unset', 'empty'] as const) {
      const directory = join(root, `jwt-${mode}`);
      await mkdir(directory, { mode: 0o700 });
      const { compose } = await writeComposeConfiguration({
        repositoryRoot: lifecycle.repositoryRoot,
        directory,
        dataDir: join(directory, 'platform-data'),
        managedDir: join(directory, 'managed'),
        port: await unusedPort(),
        userImage: lifecycle.imageId,
        // Never built: an interpolation that unexpectedly passed still fails on the image.
        platformImage: `dsh-team-test-${runId}:absent-platform`,
        dockerGid,
        runId,
        project,
        network,
        overrides: [],
        documentServerJwt: mode,
      });
      const lines = (await readFile(join(directory, 'compose.env'), 'utf8')).split('\n');
      expect(lines.some((line) => line.startsWith(`${JWT}=`))).toBe(mode === 'empty');

      const result = await lifecycle.commandAsync(
        [...compose, 'up', '-d', '--no-build', '--pull', 'never'],
        30_000,
      );
      expect(result.status === 0).toBe(false);
      expect(result.stderr).toContain(JWT);

      for (const [kind, name] of [
        ['container', PLATFORM],
        ['container', DOCUMENT_SERVER],
        ['network', network],
      ] as const)
        expect(
          isAbsentResource(
            await lifecycle.commandAsync([kind, 'inspect', name], 30_000),
            kind,
            name,
          ),
          `${kind} ${name} absent`,
        ).toBe(true);
      for (const label of [`${OWNER_LABEL}=${runId}`, `com.docker.compose.project=${project}`]) {
        const args = [
          'container',
          'ls',
          '--all',
          '--quiet',
          '--no-trunc',
          '--filter',
          `label=${label}`,
        ];
        expect(output(await lifecycle.commandAsync(args, 30_000), args).trim()).toBe('');
      }
    }
  });
});
