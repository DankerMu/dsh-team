import { randomBytes } from 'node:crypto';
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
  /**
   * The VPS stand-in for the bundled Document Server: an already captured owned image idling in
   * place of the real 8.7 GB image, with an empty private font directory. The local lane omits
   * it and runs the delivered image over the repository's `assets/fonts`.
   */
  readonly documentServer?: { readonly image: string; readonly fontsDir: string };
  /**
   * Only the rejection cases: `empty` keeps the example's empty line, `unset` drops the key.
   * Otherwise a fresh invocation-owned, nonsecret JWT is injected.
   */
  readonly documentServerJwt?: 'empty' | 'unset';
}

const DOCUMENT_SERVER_FONTS = '/usr/share/fonts/truetype/custom';

function documentServerOverride(
  ownership: Readonly<Record<string, string>>,
  standIn: ComposeConfiguration['documentServer'],
): Record<string, unknown> {
  if (standIn === undefined) return { labels: ownership };
  return {
    image: standIn.image,
    // Compose clears the image's default command when the entrypoint is set.
    entrypoint: ['node', '-e', 'setInterval(() => {}, 1 << 30)'],
    // Merged by target; every field is restated rather than inherited from the delivered entry.
    volumes: [
      {
        type: 'bind',
        source: standIn.fontsDir,
        target: DOCUMENT_SERVER_FONTS,
        read_only: true,
        bind: { create_host_path: false },
      },
    ],
    labels: ownership,
  };
}

/**
 * `.env.example` with the deployment's overrides as a 0600 env file, the ownership override, and
 * the delivered-compose argv over both (callers append the verb). The returned JWT lives only in
 * memory, the 0600 env file and the two containers' environments: never log or report it.
 */
export async function writeComposeConfiguration(
  configuration: ComposeConfiguration,
): Promise<{ base: string; compose: string[]; documentServerJwt: string | undefined }> {
  const { repositoryRoot, directory, port, runId, project, network } = configuration;
  const base = `http://127.0.0.1:${String(port)}`;
  const ownership = { [OWNER_LABEL]: runId };
  const environment: Record<string, string | undefined> = {
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
  const documentServerJwt =
    configuration.documentServerJwt === undefined ? randomBytes(32).toString('hex') : undefined;
  if (documentServerJwt !== undefined) environment.DOCUMENT_SERVER_JWT_SECRET = documentServerJwt;
  else if (configuration.documentServerJwt === 'unset')
    delete environment.DOCUMENT_SERVER_JWT_SECRET;
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
      services: {
        platform: { image: configuration.platformImage, labels: ownership },
        documentserver: documentServerOverride(ownership, configuration.documentServer),
      },
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
  return { base, compose, documentServerJwt };
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
