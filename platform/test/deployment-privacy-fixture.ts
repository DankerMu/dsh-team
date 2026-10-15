import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { extractLaunchToken } from '../src/orchestrator/index.ts';
import { record } from './container-start-docker-fixture.ts';
import { configureDeployment } from './deployment-account-fixture.ts';
import { withDeployment } from './deployment-fixture.ts';
import type { Deployment } from './deployment-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

interface Progress {
  phase: string;
}
interface NativeReader {
  rpc(cookie: string, method: string, args: unknown): Promise<Record<string, unknown>>;
  history(cookie: string, sessionId: string): Promise<readonly unknown[]>;
}
interface PrivacySnapshot {
  stored: Record<string, unknown>;
  logs: string;
  needles: readonly string[];
  userId: string;
  sessionId: string;
  barrier: string;
}

async function conversation(
  gateway: NativeReader,
  cookie: string,
  marker: string,
  reply: string,
  progress: Progress,
): Promise<string> {
  progress.phase = 'session-create';
  const created = await gateway.rpc(cookie, 'session/create', {
    request: { cwd: '/data/work', agentPreset: 'office-general' },
  });
  if (typeof created.sessionId !== 'string') throw new Error('Missing Session');
  const sessionId = created.sessionId;
  progress.phase = 'session-prompt';
  expect(
    await gateway.rpc(cookie, 'session/prompt', {
      request: {
        sessionId,
        requestId: randomUUID(),
        content: [{ type: 'text', text: marker }],
        mode: 'queue',
      },
    }),
  ).toEqual({ accepted: true });
  progress.phase = 'native-turn-completion';
  await expect
    .poll(
      async () =>
        (await gateway.history(cookie, sessionId)).some((row) => {
          const event = record(record(row).event);
          return (
            event.type === 'turn/end' && record(record(event.data).reason).kind === 'completed'
          );
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  progress.phase = 'native-content-proof';
  const events = (await gateway.history(cookie, sessionId)).map((row) => record(record(row).event));
  expect(
    events.some(
      (event) => event.type === 'user/message' && JSON.stringify(event.data).includes(marker),
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) => event.type === 'assistant/message' && JSON.stringify(event.data).includes(reply),
    ),
  ).toBe(true);
  expect(events.some((event) => event.type === 'assistant/attempt')).toBe(false);
  return sessionId;
}

function scanEvidence(snapshot: PrivacySnapshot, progress: Progress): void {
  const { stored, logs, needles, userId, sessionId, barrier } = snapshot;
  progress.phase = 'complete-audit-log-scan';
  if (!Array.isArray(stored.rows)) throw new Error('Missing complete audit rows');
  expect(record(stored.user).status).toBe('disabled');
  const rows = stored.rows.map((row: unknown) => record(row));
  for (const event of [
    'admin.created',
    'account.registered',
    'login.succeeded',
    'password.changed',
    'model-config.updated',
    'account.disabled',
    'instance.ready',
    'instance.stopped',
  ])
    expect(rows.some((row) => row.event_type === event)).toBe(true);
  progress.phase = 'complete-needle-inventory';
  expect(needles.every((value) => value.length >= 16)).toBe(true);
  expect(new Set(needles).size).toBe(14);
  const audit = JSON.stringify(stored.rows);
  progress.phase = 'platform-log-decoding';
  const entries = logs
    .trim()
    .split('\n')
    .map((line) => record(JSON.parse(line)));
  progress.phase = 'platform-log-barrier';
  const endRequest = entries.find(
    (entry) => entry.req !== undefined && record(entry.req).url === `/healthz?${barrier}`,
  );
  expect(typeof endRequest?.reqId).toBe('string');
  expect(
    entries.some(
      (entry) =>
        entry.reqId === endRequest?.reqId &&
        entry.res !== undefined &&
        record(entry.res).statusCode === 200 &&
        entry.msg === 'request completed',
    ),
  ).toBe(true);
  progress.phase = 'platform-log-operation-coverage';
  for (const path of [
    '/_platform/api/register',
    '/_platform/api/login',
    '/_platform/api/admin/model-config',
    '/api/session/prompt',
    '/_platform/api/change-password',
    `/_platform/api/admin/users/${userId}/status`,
  ])
    expect(entries.some((entry) => entry.req !== undefined && record(entry.req).url === path)).toBe(
      true,
    );
  progress.phase = 'credential-content-absence';
  for (const needle of needles) {
    expect(audit.includes(needle), 'audit credential/content leak').toBe(false);
    expect(logs.includes(needle), 'platform log credential/content leak').toBe(false);
  }
  process.stdout.write(
    JSON.stringify({
      privacyScan: {
        credentials: needles.length - 2,
        contentMarkers: 2,
        auditRows: rows.length,
        logEntries: entries.length,
        sessionId,
        complete: true,
      },
    }) + '\n',
  );
}

async function preparePrivacyModel(
  lifecycle: UserImageLifecycle,
  deployment: Deployment,
  config: Record<string, string>,
): Promise<void> {
  const configPath = join(deployment.directory, 'privacy-model.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const override = join(deployment.directory, 'privacy-compose.json');
  await writeFile(
    override,
    JSON.stringify({
      services: {
        platform: {
          environment: { PLATFORM_LOG_LEVEL: 'info' },
          volumes: [
            {
              type: 'bind',
              source: join(lifecycle.repositoryRoot, 'platform/test/deployment-model-wire.ts'),
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
  deployment.compose.push('--file', override);
}

export async function verifyDeployedCredentialPrivacy(): Promise<void> {
  const marker = `private-conversation-${randomUUID()}`;
  const reply = `private-reply-${randomUUID()}`;
  const model = 'owned-privacy-model';
  const key = randomUUID();
  const replacementKey = randomUUID();
  const newPassword = randomUUID();
  const progress = { phase: 'setup' };
  try {
    await withDeployment(
      async (lifecycle, start) => {
        const { deployment, employee, admin } = await configureDeployment(lifecycle, start);
        const origin = deployment.base;
        const gateway = instanceGatewayFixture({ lifecycle, base: origin, origin });
        const run = async (args: string[]) => {
          const result = await lifecycle.commandAsync(args, 15_000);
          if (result.status !== 0 || result.error !== undefined)
            throw new Error('Private observation failed');
          return result;
        };
        const platformRead = async (script: string) =>
          record(
            JSON.parse(
              (
                await run([
                  'exec',
                  'dsh-team-platform',
                  'node',
                  '--input-type=module',
                  '-e',
                  script,
                ])
              ).stdout,
            ),
          );
        const mutate = async (
          path: string,
          method: string,
          body: unknown,
          cookie: string,
          status: number,
        ) => {
          const response = await deployment.request(`${origin}${path}`, {
            method,
            headers: { origin, cookie, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          expect(response.status).toBe(status);
          await response.arrayBuffer();
          return response;
        };
        const db = `import {join} from 'node:path';import {loadConfig} from './platform/dist/config.js';import {openDatabase} from './platform/dist/db/index.js';const db=openDatabase(join(loadConfig(process.env).dataDir,'platform.db'));`;
        const settings = {
          baseURL: 'http://dsh-team-platform:3099/v1',
          models: [{ name: model }],
          defaultModel: model,
        };
        const cookies = [admin.cookie, employee.registrationCookie, employee.cookie];
        progress.phase = 'local-model';
        await run([
          'exec',
          '--detach',
          'dsh-team-platform',
          'node',
          '/verification/model.ts',
          '/verification/model.json',
        ]);
        await expect
          .poll(
            async () =>
              platformRead(
                "const r=await fetch('http://127.0.0.1:3099/health');process.stdout.write(await r.text());",
              ),
            { timeout: 10_000 },
          )
          .toMatchObject({ ready: true });
        await mutate(
          '/_platform/api/admin/model-config',
          'PUT',
          { ...settings, apiKey: key },
          admin.cookie,
          200,
        );
        await gateway.state(employee.cookie, true);
        await gateway.ready(employee.cookie);
        progress.phase = 'native-credentials';
        const instance = `dsh-team-u-${employee.id}`;
        const launch = await run(['logs', instance]);
        const token = extractLaunchToken(launch.stdout);
        const native = await platformRead(
          `${db}try{process.stdout.write(JSON.stringify(db.prepare('SELECT dsh_cookie FROM instances WHERE user_id=?').get(${JSON.stringify(employee.id)})));}finally{db.close();}`,
        );
        if (!token || typeof native.dsh_cookie !== 'string')
          throw new Error('Missing native credential');
        const nativeCookie = native.dsh_cookie;
        const sessionId = await conversation(gateway, employee.cookie, marker, reply, progress);
        const observed = await platformRead(
          "const r=await fetch('http://127.0.0.1:3099/health');process.stdout.write(await r.text());",
        );
        expect(typeof observed.markedRequests === 'number' && observed.markedRequests > 0).toBe(
          true,
        );
        progress.phase = 'password-change';
        const changed = await mutate(
          '/_platform/api/change-password',
          'POST',
          { currentPassword: 'instance-acceptance-password', newPassword },
          employee.cookie,
          204,
        );
        const changedCookie = changed.headers.get('set-cookie')?.split(';')[0];
        if (!changedCookie) throw new Error('Missing replacement session');
        cookies.push(changedCookie);
        expect(new Set(cookies).size).toBe(4);
        progress.phase = 'model-update';
        await mutate(
          '/_platform/api/admin/model-config',
          'PUT',
          { ...settings, apiKey: replacementKey },
          admin.cookie,
          200,
        );
        progress.phase = 'account-disable';
        await mutate(
          `/_platform/api/admin/users/${employee.id}/status`,
          'PUT',
          { status: 'disabled' },
          admin.cookie,
          204,
        );
        progress.phase = 'disabled-login';
        await mutate(
          '/_platform/api/login',
          'POST',
          { email: employee.email, password: newPassword },
          '',
          403,
        );
        const barrier = `privacy-barrier-${lifecycle.runId}`;
        const health = await deployment.request(`${origin}/healthz?${barrier}`);
        expect(health.status).toBe(200);
        await health.arrayBuffer();
        progress.phase = 'complete-audit-log-scan';
        const stored = await platformRead(
          `${db}try{process.stdout.write(JSON.stringify({rows:db.prepare('SELECT * FROM audit_events ORDER BY id').all(),user:db.prepare('SELECT status FROM users WHERE id=?').get(${JSON.stringify(employee.id)})}));}finally{db.close();}`,
        );
        const needles = [
          admin.password,
          'instance-acceptance-password',
          newPassword,
          'deployment-acceptance-key',
          key,
          replacementKey,
          token,
          nativeCookie.slice(nativeCookie.indexOf('=') + 1),
          marker,
          reply,
          ...cookies.map((cookie) => cookie.slice(cookie.indexOf('=') + 1)),
        ];
        progress.phase = 'complete-platform-logs';
        const logs = await run(['logs', 'dsh-team-platform']);
        scanEvidence(
          {
            stored,
            logs: logs.stdout + logs.stderr,
            needles,
            userId: employee.id,
            sessionId,
            barrier,
          },
          progress,
        );
        gateway.close();
      },
      (lifecycle, deployment) =>
        preparePrivacyModel(lifecycle, deployment, { key, model, marker, reply }),
    );
  } catch {
    throw new Error(
      `Deployed privacy acceptance failed during ${progress.phase}; private diagnostics withheld`,
    );
  }
}
