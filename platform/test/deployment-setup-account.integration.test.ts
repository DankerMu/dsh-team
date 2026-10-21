import type * as ChildProcessModule from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { configureDeployment } from './deployment-account-fixture.ts';
import type { Deployment } from './deployment-fixture.ts';
import { createDeploymentSetupEvidence } from './deployment-setup-evidence.ts';
import type { DeploymentSetupSnapshot } from './deployment-setup-evidence.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';
import type * as ObserverModule from './deployment-observer-fixture.ts';
import { substituteObservation } from './deployment-observer-substitute.ts';

const observer = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('./deployment-observer-fixture.ts', async (importOriginal) => {
  const { observerSubstitute } = await import('./deployment-observer-substitute.ts');
  return observerSubstitute(await importOriginal<typeof ObserverModule>(), (event) => {
    observer.events.push(event);
  });
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  // Substitute only the external PTY process, not configureDeployment/runPty.
  spawnSync(binary: string, args: readonly string[]) {
    if (binary !== 'python3' || !args[0]?.endsWith('/cli-pty.py'))
      throw new Error('Unexpected external process in account setup regression');
    return {
      status: 0,
      stdout: JSON.stringify({
        exitCode: 0,
        echoBefore: true,
        echoAfter: true,
        canonicalBefore: true,
        canonicalAfter: true,
        modeRestored: true,
        echoDuring: [false, false],
        leakedInput: false,
        output: 'private-terminal-output-canary',
        harnessError: null,
      }),
      stderr: '',
    };
  },
}));

function imageDaemon() {
  const images = new Map<string, string>();
  function inspectImage(args: readonly string[], name: string): DockerCommandResult {
    if (!images.has(name))
      return { status: 1, stdout: '[]\n', stderr: `Error: No such image: ${name}\n` };
    return {
      status: 0,
      stdout: args.includes('{{.Id}}')
        ? `sha256:${'a'.repeat(64)}\n`
        : `${images.get(name) ?? ''}\n`,
      stderr: '',
    };
  }
  const command: DockerCommand = (args) => {
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'version') return ok('29.1.3\n');
    if (args[0] === 'build') {
      images.set(
        args[args.indexOf('--tag') + 1] ?? '',
        (args[args.indexOf('--label') + 1] ?? '').split('=')[1] ?? '',
      );
      return ok();
    }
    const name = args.at(-1) ?? '';
    if (args[0] === 'image' && args[1] === 'inspect') return inspectImage(args, name);
    if (args[0] === 'image' && args[1] === 'rm') {
      images.delete(name);
      return ok();
    }
    if (args[1] === 'inspect')
      return { status: 1, stdout: '[]\n', stderr: `Error: No such ${args[0] ?? ''}: ${name}\n` };
    throw new Error('Unexpected external Docker operation in account setup regression');
  };
  return { command, images };
}

it('distinguishes late model configuration rejection from completed administrator setup and preserves the original failure', async () => {
  const primary = Object.assign(
    new AggregateError(
      [new Error('private-aggregate-member-canary')],
      'private-primary-message-canary',
      { cause: new Error('private-nested-cause-canary') },
    ),
    {
      output: 'private-command-output-canary',
      args: ['private-argument-canary'],
      env: 'private-environment-canary',
    },
  );
  const reports: DeploymentSetupSnapshot[] = [];
  const setup = createDeploymentSetupEvidence((snapshot) => {
    reports.push(snapshot);
  });
  const daemon = imageDaemon();
  const requests: string[] = [];
  let observed: unknown;

  await runUserImage(
    'container-start',
    () => undefined,
    daemon.command,
    async (lifecycle) => {
      const deployment: Deployment = {
        base: 'http://deployment.example.test',
        port: 80,
        directory: lifecycle.overlayDirectory,
        dataDir: lifecycle.overlayDirectory,
        compose: [],
        observation: substituteObservation(true),
        request: (url) =>
          Promise.resolve().then(() => {
            const path = new URL(url).pathname;
            requests.push(path);
            if (path === '/healthz') return Response.json({ status: 'ok' });
            if (path === '/_platform/api/login')
              return Response.json(
                { role: 'admin', email: 'administrator@deployment.example.test' },
                { headers: { 'set-cookie': 'platform_session=private-cookie-canary; HttpOnly' } },
              );
            if (path === '/_platform/api/admin/model-config') throw primary;
            throw new Error('Account work continued after model setup rejected');
          }),
      };
      try {
        await configureDeployment(lifecycle, () => Promise.resolve(deployment), setup);
      } catch (error) {
        observed = error;
        throw error;
      }
      return 'unexpected acceptance';
    },
  ).catch(() => undefined);
  await setup.publish();

  expect(observed).toBe(primary);
  expect(observer.events.splice(0)).toEqual(['ready']);
  expect(requests).toEqual([
    '/healthz',
    '/_platform/api/login',
    '/_platform/api/admin/model-config',
  ]);
  expect(daemon.images.size).toBe(0);
  expect(reports).toEqual([
    {
      current: 'model-configuration',
      lastCompleted: 'administrator-login',
      firstFailure: { phase: 'model-configuration', code: 'operation-failed', cause: 'unknown' },
      operations: {
        'account-configuration': 'failed',
        health: 'completed',
        'administrator-terminal': 'completed',
        'administrator-login': 'completed',
        'model-configuration': 'failed',
      },
      cleanup: { deploymentDrain: 'not-required', resources: 'not-required' },
      evidence: 'retained',
    },
  ]);
  expect(JSON.stringify(reports)).not.toContain('private-');
});

it('completes account setup only after employee registration and keeps cleanup unconfirmed until the canonical lifecycle finishes', async () => {
  const reports: DeploymentSetupSnapshot[] = [];
  const setup = createDeploymentSetupEvidence((snapshot) => {
    reports.push(snapshot);
  });
  const daemon = imageDaemon();
  const requests: string[] = [];
  let duringEmployee: DeploymentSetupSnapshot | undefined;
  let beforeCleanup: DeploymentSetupSnapshot | undefined;
  let employeeId: string | undefined;

  await runUserImage(
    'container-start',
    () => undefined,
    daemon.command,
    async (lifecycle) => {
      const deployment: Deployment = {
        base: 'http://deployment.example.test',
        port: 80,
        directory: lifecycle.overlayDirectory,
        dataDir: lifecycle.overlayDirectory,
        compose: [],
        observation: substituteObservation(true),
        request: (url, init) =>
          Promise.resolve().then(() => {
            const path = new URL(url).pathname;
            requests.push(path);
            if (path === '/healthz') return Response.json({ status: 'ok' });
            if (path === '/_platform/api/login')
              return Response.json(
                { role: 'admin', email: 'administrator@deployment.example.test' },
                { headers: { 'set-cookie': `platform_session=${'f'.repeat(64)}; HttpOnly` } },
              );
            if (path === '/_platform/api/admin/model-config' && init?.method === 'PUT')
              return Response.json({
                baseURL: 'http://models.invalid/v1',
                models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
                defaultModel: 'beta',
                apiKeyConfigured: true,
                runningInstances: 0,
              });
            if (path === '/_platform/api/register') {
              duringEmployee = setup.snapshot();
              return Response.json(
                { id: 'abcdefghijkl' },
                {
                  status: 201,
                  headers: { 'set-cookie': `platform_session=${'e'.repeat(64)}; HttpOnly` },
                },
              );
            }
            throw new Error('Unexpected account HTTP operation');
          }),
      };
      const configured = await configureDeployment(
        lifecycle,
        () => Promise.resolve(deployment),
        setup,
      );
      employeeId = configured.employee.id;
      beforeCleanup = setup.snapshot();
      return 'account setup completed';
    },
    setup,
  );
  await setup.publish();

  expect(employeeId).toBe('abcdefghijkl');
  expect(observer.events.splice(0)).toEqual(['ready']);
  expect(requests).toEqual([
    '/healthz',
    '/_platform/api/login',
    '/_platform/api/admin/model-config',
    '/_platform/api/register',
    '/_platform/api/login',
  ]);
  expect(duringEmployee).toMatchObject({
    current: 'employee-registration',
    lastCompleted: 'model-configuration',
    firstFailure: null,
    operations: { 'account-configuration': 'entered', 'employee-registration': 'entered' },
  });
  expect(beforeCleanup).toMatchObject({
    current: null,
    lastCompleted: 'account-configuration',
    firstFailure: null,
    cleanup: { deploymentDrain: 'not-required', resources: 'unconfirmed' },
  });
  expect(reports).toEqual([
    {
      current: null,
      lastCompleted: 'account-configuration',
      firstFailure: null,
      operations: {
        'user-image-preparation': 'completed',
        'account-configuration': 'completed',
        health: 'completed',
        'administrator-terminal': 'completed',
        'administrator-login': 'completed',
        'model-configuration': 'completed',
        'employee-registration': 'completed',
      },
      cleanup: { deploymentDrain: 'not-required', resources: 'confirmed' },
      evidence: 'retained',
    },
  ]);
  expect([...daemon.images]).toEqual([]);
});
