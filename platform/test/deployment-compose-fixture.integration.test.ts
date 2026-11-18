import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import { writeComposeConfiguration } from './deployment-compose-fixture.ts';
import type { ComposeConfiguration } from './deployment-compose-fixture.ts';
import { OWNER_LABEL } from './docker-cleanup.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const KEY = 'DOCUMENT_SERVER_JWT_SECRET';
const RUN = 'run-under-test';
// Plain responders, as the platform image's `node` user, behind the holder's firewall.
const STAND_IN =
  "for (const port of [80, 8000]) require('node:http').createServer((_, res) => res.end()).listen(port)";
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** A private directory holding the shipped example, never a hand-written copy. */
async function configure(extra: Partial<ComposeConfiguration> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-compose-fixture-'));
  directories.push(directory);
  await copyFile(join(root, '.env.example'), join(directory, '.env.example'));
  const written = await writeComposeConfiguration({
    repositoryRoot: directory,
    directory,
    dataDir: join(directory, 'data'),
    managedDir: join(directory, 'managed'),
    port: 18_080,
    userImage: 'sha256:user',
    platformImage: 'sha256:platform',
    dockerGid: 999,
    runId: RUN,
    project: 'dsh-team-test-project',
    network: 'dsh-team-test-project_default',
    overrides: [],
    ...extra,
  });
  const environmentPath = join(directory, 'compose.env');
  const text = await readFile(environmentPath, 'utf8');
  const override = JSON.parse(await readFile(join(directory, 'compose.json'), 'utf8')) as {
    services: Record<string, Record<string, unknown>>;
  };
  return {
    directory,
    written,
    text,
    environment: parseEnv(text),
    mode: (await stat(environmentPath)).mode & 0o777,
    override,
  };
}

// Booleans only: a failing matcher would print the whole argument, never the JWT itself.
it('injects a fresh 64-hex JWT into the private env file and hands it only to the caller', async () => {
  const first = await configure();
  const second = await configure();

  expect(first.mode).toBe(0o600);
  const jwt = first.written.documentServerJwt ?? '';
  expect(/^[0-9a-f]{64}$/.test(jwt)).toBe(true);
  expect(first.environment[KEY] === jwt).toBe(true);
  expect(first.text.split('\n').filter((line) => line.startsWith(`${KEY}=`)).length).toBe(1);
  expect(second.written.documentServerJwt !== jwt).toBe(true);
  expect(second.environment[KEY] === second.written.documentServerJwt).toBe(true);
});

it.each([
  ['empty', true],
  ['unset', false],
] as const)(
  'keeps the %s rejection input without generating a JWT',
  async (documentServerJwt, present) => {
    const { written, environment, text, mode } = await configure({ documentServerJwt });

    expect(mode).toBe(0o600);
    expect(written.documentServerJwt === undefined).toBe(true);
    expect(Object.hasOwn(environment, KEY)).toBe(present);
    const lines = text.split('\n').filter((line) => line.startsWith(`${KEY}=`));
    expect(lines.length === (present ? 1 : 0) && lines.every((line) => line === `${KEY}=""`)).toBe(
      true,
    );
  },
);

it('labels the bundled Document Server and runs its namespace holder from the captured platform image', async () => {
  const { override } = await configure();

  expect(override.services).toEqual({
    platform: { image: 'sha256:platform', labels: { [OWNER_LABEL]: RUN } },
    'documentserver-net': { image: 'sha256:platform', labels: { [OWNER_LABEL]: RUN } },
    documentserver: { labels: { [OWNER_LABEL]: RUN } },
  });
});

it('replaces the Document Server with the captured image answering on 80 and 8000 and private fonts', async () => {
  const fontsDir = '/private/owned/document-server-fonts';
  const { override } = await configure({
    documentServer: { image: 'sha256:platform', fontsDir },
  });

  expect(override.services.documentserver).toEqual({
    image: 'sha256:platform',
    entrypoint: ['node', '-e', STAND_IN],
    volumes: [
      {
        type: 'bind',
        source: fontsDir,
        target: '/usr/share/fonts/truetype/custom',
        read_only: true,
        bind: { create_host_path: false },
      },
    ],
    labels: { [OWNER_LABEL]: RUN },
  });
});

// The VPS stand-in rewrites this mount by target, so only the delivered file itself proves it.
it('delivers the operator fonts and the Command Service rule as read-only, never-created binds', async () => {
  const delivered = parse(await readFile(join(root, 'deploy/compose.yml'), 'utf8')) as {
    services: Record<string, { volumes?: unknown }>;
  };

  expect(delivered.services.documentserver?.volumes).toEqual(
    [
      ['./assets/fonts', '/usr/share/fonts/truetype/custom'],
      ['./deploy/document-server-command.conf', '/etc/nginx/includes/ds-acl-command.conf'],
    ].map(([source, target]) => ({
      type: 'bind',
      source,
      target,
      read_only: true,
      bind: { create_host_path: false },
    })),
  );
});

// #624: the Document Server joins the holder's namespace, and the platform attaches the holder.
it('runs the Document Server in the firewall holder namespace the platform attaches', async () => {
  const delivered = parse(await readFile(join(root, 'deploy/compose.yml'), 'utf8')) as {
    services: Record<string, Record<string, unknown>>;
  };
  const { platform, documentserver } = delivered.services;

  expect(delivered.services['documentserver-net']).toMatchObject({
    image: 'dsh-team-platform:local',
    container_name: 'dsh-team-documentserver-net',
    user: 'root',
    cap_add: ['NET_ADMIN'],
    entrypoint: ['/app/deploy/document-server-net.sh'],
    healthcheck: { test: ['CMD', 'test', '-f', '/run/dsh-team/firewall-ready'] },
  });
  expect(documentserver).toMatchObject({
    network_mode: 'service:documentserver-net',
    depends_on: { 'documentserver-net': { condition: 'service_healthy', restart: true } },
  });
  expect(platform?.environment).toMatchObject({
    DOCUMENT_SERVER_CONTAINER_NAME: 'dsh-team-documentserver-net',
  });
});

// No inventory gate reads compose interpolation; only the delivered file proves the passthrough.
it('passes the instance fonts directory to the platform at the identical read-only path', async () => {
  const delivered = parse(await readFile(join(root, 'deploy/compose.yml'), 'utf8')) as {
    services: Record<string, { environment?: Record<string, unknown>; volumes?: unknown[] }>;
  };
  const platform = delivered.services.platform;

  expect(platform?.environment?.PLATFORM_INSTANCE_FONTS_DIR).toBe(
    '${PLATFORM_INSTANCE_FONTS_DIR:-}',
  );
  expect(platform?.volumes).toContainEqual({
    type: 'bind',
    source: '${PLATFORM_INSTANCE_FONTS_DIR:-./deploy}',
    target: '${PLATFORM_INSTANCE_FONTS_DIR:-/opt/dsh-team/instance-fonts-unset}',
    read_only: true,
    bind: { create_host_path: false },
  });
});
