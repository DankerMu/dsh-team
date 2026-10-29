import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { START_CONTAINER, startupOwnerFixture } from './container-start-fixture.ts';
import type { StartupOwnerFixture } from './container-start-fixture.ts';
import { isBadOverlayFastExit } from './bad-overlay-start-failure.ts';

const FAST_EXIT_MESSAGE = 'Container startup failed during started container inspection';
const FAST_EXIT_CAUSE = {
  stage: 'started container inspection',
  cleanupFailed: false,
  networkUnconfirmed: false,
  dockerStatus: undefined,
};

let context: StartupOwnerFixture;

beforeEach(async () => {
  context = await startupOwnerFixture();
});

afterEach(async () => {
  context.database.close();
  await rm(context.root, { recursive: true, force: true });
});

async function startFailure(): Promise<Error> {
  try {
    await context.owner.startUserContainer(context.input);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
  throw new Error('Startup unexpectedly succeeded');
}

it('rejects a Docker start failure as a bad-overlay fast exit', async () => {
  context.daemon.overrides.set(`POST /containers/${START_CONTAINER}/start`, { status: 500 });

  const error = await startFailure();

  expect(error.message).toBe('Container startup failed during container start');
  expect(error.cause).toMatchObject({ dockerStatus: 500 });
  expect(isBadOverlayFastExit(error)).toBe(false);
});

it('accepts the real error of a container that exited before started inspection', async () => {
  context.daemon.beforeRequest((request) => {
    if (request.path !== `/containers/${START_CONTAINER}/json`) return;
    const container = context.daemon.containers.get(START_CONTAINER);
    if (!container) throw new Error('Missing fixture container');
    if (container.State.Running) container.State.Running = false;
  });

  const error = await startFailure();

  expect(error.message).toBe(FAST_EXIT_MESSAGE);
  expect(JSON.stringify(error.cause)).toBe(
    '{"stage":"started container inspection","cleanupFailed":false,"networkUnconfirmed":false}',
  );
  expect(isBadOverlayFastExit(error)).toBe(true);
});

class StartupSubclassError extends Error {}

it.each([
  ['a non-Error value', { message: FAST_EXIT_MESSAGE, cause: FAST_EXIT_CAUSE }],
  ['the same message without cause', new Error(FAST_EXIT_MESSAGE)],
  [
    'a cleanup failure',
    new Error(FAST_EXIT_MESSAGE, { cause: { ...FAST_EXIT_CAUSE, cleanupFailed: true } }),
  ],
  [
    'an unconfirmed network',
    new Error(FAST_EXIT_MESSAGE, { cause: { ...FAST_EXIT_CAUSE, networkUnconfirmed: true } }),
  ],
  [
    'a Docker status',
    new Error(FAST_EXIT_MESSAGE, { cause: { ...FAST_EXIT_CAUSE, dockerStatus: 404 } }),
  ],
  [
    'another stage',
    new Error(FAST_EXIT_MESSAGE, {
      cause: { ...FAST_EXIT_CAUSE, stage: 'created container inspection' },
    }),
  ],
  [
    'an Error subclass',
    new StartupSubclassError(FAST_EXIT_MESSAGE, { cause: { ...FAST_EXIT_CAUSE } }),
  ],
])('rejects %s', (_case, value) => {
  expect(isBadOverlayFastExit(value)).toBe(false);
});

it('accepts the minimal matching plain error', () => {
  expect(
    isBadOverlayFastExit(new Error(FAST_EXIT_MESSAGE, { cause: { ...FAST_EXIT_CAUSE } })),
  ).toBe(true);
});
