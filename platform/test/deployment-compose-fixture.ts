import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import { OWNER_LABEL } from './docker-cleanup.ts';

/** Docker CLI boundary of one owned invocation: rejects unless the command succeeded. */
export type DockerOutput = (args: string[], timeout?: number) => Promise<string>;

/**
 * The one platform image build over this checkout's repository-root context; an uploaded
 * verification artifact may supply its own argv.
 */
export async function buildPlatformImage(
  run: DockerOutput,
  runId: string,
  image: string,
  artifactArgs?: string[],
): Promise<void> {
  await run(
    artifactArgs ?? [
      'build',
      '--label',
      `${OWNER_LABEL}=${runId}`,
      '--tag',
      image,
      '--file',
      'platform/Dockerfile',
      '.',
    ],
    600_000,
  );
}

export async function platformImageId(run: DockerOutput, image: string): Promise<string> {
  const id = (await run(['image', 'inspect', '--format', '{{.Id}}', image])).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Platform image identity missing');
  return id;
}

export interface ComposeConfiguration {
  readonly repositoryRoot: string;
  /** Private 0700 directory receiving the 0600 env and override files. */
  readonly directory: string;
  readonly dataDir: string;
  readonly managedDir: string;
  readonly port: number;
  readonly userImage: string;
  readonly platformImage: string;
  readonly dockerGid: number;
  readonly runId: string;
  readonly project: string;
  readonly network: string;
  /** Additional override files appended after the ownership override. */
  readonly overrides: readonly string[];
}

/**
 * `.env.example` with the deployment's overrides as a 0600 env file, the ownership override, and
 * the delivered-compose argv over both (callers append the verb).
 */
export async function writeComposeConfiguration(
  configuration: ComposeConfiguration,
): Promise<{ base: string; compose: string[] }> {
  const { repositoryRoot, directory, port, runId, project, network } = configuration;
  const base = `http://127.0.0.1:${String(port)}`;
  const ownership = { [OWNER_LABEL]: runId };
  const environment = {
    ...parseEnv(await readFile(join(repositoryRoot, '.env.example'), 'utf8')),
    PLATFORM_HOST: '0.0.0.0',
    PLATFORM_PORT: String(port),
    PLATFORM_LOG_LEVEL: 'silent',
    PLATFORM_DATA_DIR: configuration.dataDir,
    PLATFORM_MANAGED_CONFIG_DIR: configuration.managedDir,
    PLATFORM_DOCKER_SOCKET: '/var/run/docker.sock',
    PLATFORM_USER_IMAGE: configuration.userImage,
    PLATFORM_SECCOMP_PROFILE: '/app/images/seccomp/dsh-user.json',
    PLATFORM_PUBLIC_URL: base,
    PLATFORM_UPSTREAM_MODE: 'network',
    PLATFORM_CONTAINER_NAME: 'dsh-team-platform',
    DEPLOY_DOCKER_GID: String(configuration.dockerGid),
  };
  const environmentPath = join(directory, 'compose.env');
  const override = join(directory, 'compose.json');
  await writeFile(
    environmentPath,
    Object.entries(environment)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  await writeFile(
    override,
    JSON.stringify({
      services: { platform: { image: configuration.platformImage, labels: ownership } },
      networks: { default: { name: network, labels: ownership } },
    }),
    { mode: 0o600 },
  );
  const compose = [
    'compose',
    '--project-directory',
    repositoryRoot,
    '--env-file',
    environmentPath,
    '--file',
    join(repositoryRoot, 'deploy/compose.yml'),
    '--file',
    override,
    ...configuration.overrides.flatMap((file) => ['--file', file]),
    '--project-name',
    project,
  ];
  return { base, compose };
}

/**
 * The owned deterministic model provider (`deployment-model-wire.ts`) and its 0600 configuration,
 * bound read-only into the platform container by a 0600 override file whose path is returned. A
 * running platform cannot gain bind mounts, so callers add the path before `compose up`.
 */
export async function writeModelProviderOverride(
  repositoryRoot: string,
  directory: string,
  config: Readonly<Record<string, unknown>>,
): Promise<string> {
  const configPath = join(directory, 'model-provider.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const override = join(directory, 'model-provider-compose.json');
  await writeFile(
    override,
    JSON.stringify({
      services: {
        platform: {
          environment: { PLATFORM_LOG_LEVEL: 'info' },
          volumes: [
            {
              type: 'bind',
              source: join(repositoryRoot, 'platform/test/deployment-model-wire.ts'),
              target: '/verification/model.ts',
              read_only: true,
              bind: { create_host_path: false },
            },
            {
              type: 'bind',
              source: configPath,
              target: '/verification/model.json',
              read_only: true,
              bind: { create_host_path: false },
            },
          ],
        },
      },
    }),
    { mode: 0o600 },
  );
  return override;
}

/**
 * Only readiness polling; never recreate a failed deployment to obtain success. Vitest-free:
 * the deployment fixture is also loaded by plain Node (`deployment.docker.test.ts` contention).
 */
export async function pollHealth(
  request: (url: string, init?: RequestInit) => Promise<Response>,
  base: string,
  timeout: number,
): Promise<void> {
  const deadline = performance.now() + timeout;
  let last: string;
  for (;;) {
    try {
      const response = await request(`${base}/healthz`, { signal: AbortSignal.timeout(2_000) });
      const body: unknown = await response.json();
      if (response.status === 200 && isDeepStrictEqual(body, { status: 'ok' })) return;
      last = `HTTP ${String(response.status)}`;
    } catch {
      last = 'unreachable';
    }
    if (performance.now() >= deadline)
      throw new Error(`Platform health not ready within ${String(timeout)}ms (${last})`);
    await delay(50);
  }
}
