import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { waitForDeployment } from './deployment-account-fixture.ts';
import { writeComposeConfiguration } from './deployment-compose-fixture.ts';
import { withDeployment } from './deployment-fixture.ts';
import { output, OWNER_LABEL } from './docker-cleanup.ts';
import { isAbsentResource } from './docker-command.ts';
import { DOCUMENT_SERVER_NET, holderProbeExit } from './document-server-net-fixture.ts';
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

/** The delivered `documentserver.healthcheck`: its argv and its start period in milliseconds. */
async function deliveredHealthcheck(repositoryRoot: string) {
  const delivered = parse(await readFile(join(repositoryRoot, 'deploy/compose.yml'), 'utf8')) as {
    services: Record<string, { healthcheck?: { test?: unknown; start_period?: unknown } }>;
  };
  const { test, start_period: period } = delivered.services.documentserver?.healthcheck ?? {};
  const seconds = typeof period === 'string' ? /^(\d+)s$/.exec(period)?.[1] : undefined;
  if (!Array.isArray(test) || seconds === undefined)
    throw new Error('Delivered Document Server healthcheck unreadable');
  const argv: unknown[] = test;
  return { test: argv, startPeriodMs: Number(seconds) * 1_000 };
}

/** Polls `State.Health` until `healthy`, failing once the start period since StartedAt is over. */
async function healthyWithinStartPeriod(lifecycle: UserImageLifecycle, startPeriodMs: number) {
  for (;;) {
    const state = record((await inspectAsync(lifecycle, DOCUMENT_SERVER)).State);
    const status = record(state.Health).Status;
    if (status === 'healthy') return;
    const startedAt = Date.parse(String(state.StartedAt));
    if (Number.isNaN(startedAt) || Date.now() - startedAt >= startPeriodMs)
      throw new Error(
        `Document Server stand-in not healthy within its start period: ${String(status)}`,
      );
    await delay(1_000);
  }
}

it('starts the bundled Document Server stand-in unpublished, with the fixture JWT reaching it and the platform', async () => {
  await withDeployment(async (lifecycle, start) => {
    const deployment = await start();
    // The platform reads both values as configured and starts as usual.
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
    // The stand-in override's own mount (it replaces the delivered entry by target); the delivered
    // bind is proven by the Docker-free compose test and the local stack lane.
    const mounts: unknown = server.Mounts;
    if (!Array.isArray(mounts)) throw new Error('Document Server mounts unavailable');
    expect(
      (mounts as unknown[])
        .map((mount) => record(mount))
        .filter((mount) => mount.Destination === FONTS)
        .map(({ Destination, RW }) => ({ Destination, RW })),
      'Stand-in override font mount',
    ).toEqual([{ Destination: FONTS, RW: false }]);
    expect(environmentFacts(server)).toMatchObject({
      jwtEnabled: true,
      allowPrivate: true,
      jwtSha256: expected,
    });
    // #648: the stand-in runs the startup script's final step and so becomes healthy through the
    // delivered definition, inherited rather than overridden.
    const healthcheck = await deliveredHealthcheck(lifecycle.repositoryRoot);
    expect(record(record(server.Config).Healthcheck).Test).toEqual(healthcheck.test);
    await healthyWithinStartPeriod(lifecycle, healthcheck.startPeriodMs);
    // Negative control: the same command in the running holder, the same image without the final
    // step: grep's own "no match" (1, or 2 when a process vanished mid-scan).
    expect(record((await inspectAsync(lifecycle, DOCUMENT_SERVER_NET)).State).Running).toBe(true);
    const control = await holderProbeExit(lifecycle.commandAsync, healthcheck.test);
    expect([1, 2], `holder probe exit ${String(control)}`).toContain(control);

    // The platform attaches the namespace holder, which the Document Server joins (#624).
    const platform = await inspectAsync(lifecycle, PLATFORM);
    expect(environmentFacts(platform)).toMatchObject({
      containerName: DOCUMENT_SERVER_NET,
      platformJwtSha256: expected,
    });
  });
});

/** The same fixed-name admission the deployment fixture performs, in the same order. */
async function admitFixedNames(lifecycle: UserImageLifecycle) {
  for (const name of [PLATFORM, DOCUMENT_SERVER, DOCUMENT_SERVER_NET]) {
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
      ['container', DOCUMENT_SERVER_NET],
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

      // Exit 1 is declared because the absence checks below independently prove it; only then
      // does the bounded boundary project compose's message down to the variable name.
      const result = lifecycle.command(
        [...compose, 'up', '-d', '--no-build', '--pull', 'never'],
        30_000,
        1,
      );
      expect(result).toEqual({
        status: 1,
        stdout: '',
        stderr: `required variable ${JWT} is missing a value`,
      });

      for (const [kind, name] of [
        ['container', PLATFORM],
        ['container', DOCUMENT_SERVER],
        ['container', DOCUMENT_SERVER_NET],
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
