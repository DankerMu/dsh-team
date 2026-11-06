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

it('labels the bundled Document Server for ownership and keeps its delivered image and fonts', async () => {
  const { override } = await configure();

  expect(override.services).toEqual({
    platform: { image: 'sha256:platform', labels: { [OWNER_LABEL]: RUN } },
    documentserver: { labels: { [OWNER_LABEL]: RUN } },
  });
});

it('replaces the Document Server with the captured image, an idle entrypoint and private fonts', async () => {
  const fontsDir = '/private/owned/document-server-fonts';
  const { override } = await configure({
    documentServer: { image: 'sha256:platform', fontsDir },
  });

  expect(override.services.documentserver).toEqual({
    image: 'sha256:platform',
    entrypoint: ['node', '-e', 'setInterval(() => {}, 1 << 30)'],
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
it('delivers the operator fonts as one read-only, never-created repository-root bind', async () => {
  const delivered = parse(await readFile(join(root, 'deploy/compose.yml'), 'utf8')) as {
    services: Record<string, { volumes?: unknown }>;
  };

  expect(delivered.services.documentserver?.volumes).toEqual([
    {
      type: 'bind',
      source: './assets/fonts',
      target: '/usr/share/fonts/truetype/custom',
      read_only: true,
      bind: { create_host_path: false },
    },
  ]);
});
