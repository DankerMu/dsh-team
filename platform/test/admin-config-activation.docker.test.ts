import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { isolatedBrowserRuntime, rescueChrome } from '../../scripts/probe-browser-runtime.mjs';
import { acceptObservation, mappedFlags } from '../../scripts/probe-mapped-host.mjs';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { startBrowserPlatform } from './instance-browser-docker-fixture.ts';
import { instanceGatewayFixture, orderedMounts } from './instance-gateway-docker-fixture.ts';
import { registerInstanceUser } from './instance-fixture.ts';
import { waitDockerIdle, withDockerIdleInstance } from './instance-idle-docker-fixture.ts';
import { MANAGED_BOOT_ROSTER } from './managed-policy-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';

it('keeps the running model selector unchanged after save and activates the new exact list and default on administrator restart', async () => {
  isolatedBrowserRuntime();
  await runUserImage(
    'container-start',
    () => undefined,
    undefined,
    async (lifecycle) => {
      const host = 'dsh-team-config-activation.invalid';
      const platform = await startBrowserPlatform(lifecycle, host);
      const { app, database, base, origin } = platform;
      const gateway = instanceGatewayFixture({ base, origin, lifecycle });
      const evidence = resolve('.run/issue79', `activation-${lifecycle.runId}`);
      try {
        await mkdir(evidence, { recursive: true });
        const admin = await registerInstanceUser(base, origin, 'activation-admin@example.test');
        database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
        const employee = await registerInstanceUser(
          base,
          origin,
          'activation-employee@example.test',
        );
        const ownership = { 'dsh-team.user': employee.id };
        await lifecycle.registerResourceAsync('container', `dsh-team-u-${employee.id}`, ownership);
        for (const name of [`dsh-team-home-${employee.id}`, `dsh-team-work-${employee.id}`])
          await lifecycle.registerResourceAsync('volume', name, ownership);
        const headers = { cookie: admin.cookie, origin, 'content-type': 'application/json' };
        const config = {
          baseURL: 'http://model.invalid/v1',
          models: [{ name: 'alpha' }, { name: 'beta' }],
          defaultModel: 'beta',
        };
        const save = async (models: typeof config.models, defaultModel: string, key = false) => {
          const response = await fetch(`${base}/_platform/api/admin/model-config`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              ...config,
              models,
              defaultModel,
              ...(key ? { apiKey: 'activation-fixture-not-provider-key' } : {}),
            }),
          });
          expect(response.status).toBe(200);
          return record(await response.json());
        };
        const identity = () => {
          const row = record(
            database.prepare('SELECT container_id FROM instances WHERE user_id=?').get(employee.id),
          );
          if (typeof row.container_id !== 'string')
            throw new Error('Missing ready activation identity');
          return row.container_id;
        };
        const observedSessions = new Set<string>();
        const newSession = async () => {
          const workspace = await gateway.rpc(employee.cookie, 'workspace/create', {
            request: { path: '/data/work' },
          });
          expect(workspace.created).toBe(false);
          const workspaceId = record(workspace.workspace).workspaceId;
          if (typeof workspaceId !== 'string') throw new Error('Missing seeded workspace');
          const created = await gateway.rpc(employee.cookie, 'session/create', {
            request: { workspaceId, agentPreset: 'standard' },
          });
          if (typeof created.sessionId !== 'string') throw new Error('Missing fresh Session');
          const sessionId = created.sessionId;
          const attached = await gateway.rpc(employee.cookie, 'workspace/create', {
            request: { path: '/data/work' },
          });
          expect(attached).toMatchObject({
            created: false,
            workspace: {
              workspaceId,
              path: '/data/work',
            },
          });
          expect(record(attached.workspace).sessionIds).toContain(sessionId);
          expect(observedSessions.has(sessionId)).toBe(false);
          observedSessions.add(sessionId);
          const history = await gateway.history(employee.cookie, sessionId);
          expect(
            history.some((value) => record(record(value).event).type === 'model/selection'),
          ).toBe(false);
          return sessionId;
        };
        const observe = async (
          label: string,
          models: string,
          expectedDefault: string,
          sessionId: string,
        ) => {
          const profile = await mkdtemp(join(tmpdir(), 'dsh-team-activation-browser-'));
          const receiptFile = join(profile, 'chrome.receipt.json');
          try {
            const observation = await acceptObservation({
              origin,
              cookie: employee.cookie,
              expectedHost: host,
              extraFlags: mappedFlags(host),
              composition: true,
              expectedRoster: MANAGED_BOOT_ROSTER,
              runtime: isolatedBrowserRuntime(lifecycle.runId),
              profile: join(profile, 'profile'),
              receiptFile,
              screenshot: join(evidence, `${label}.png`),
              browserMs: 30_000,
              workspace: { available: true, workBound: true },
              preserveModels: models,
              expectedDefault,
              preserveSessionId: sessionId,
            });
            await writeFile(join(evidence, `${label}.json`), JSON.stringify(observation, null, 2));
            expect(observation.accepted).toBe(true);
            expect(observation.reload?.accepted).toBe(true);
            expect(observation.consoleErrors).toEqual([]);
            expect(observation.sessionAddressObserved).toBe(true);
            expect(observation.preservation).toMatchObject({
              sessionId,
              exactModels: models.split(','),
              defaultModel: expectedDefault,
              selected: models.split(','),
              modelSend: false,
            });
          } finally {
            await rescueChrome(receiptFile);
            await rm(profile, { recursive: true, force: true });
          }
        };

        expect(await save(config.models, config.defaultModel, true)).toEqual({
          ...config,
          apiKeyConfigured: true,
          runningInstances: 0,
        });
        expect(await gateway.state(employee.cookie, true)).toEqual({
          status: 'starting',
          reason: 'starting',
        });
        await gateway.ready(employee.cookie);
        const firstId = identity();
        const firstSession = await newSession();
        await observe('before-save', 'alpha,beta', 'beta', firstSession);
        const before = await inspectAsync(lifecycle, firstId);
        const overlay = join(lifecycle.overlayDirectory, `${employee.id}.patch.yml`);
        const bytes = await readFile(overlay);
        const inode = (await stat(overlay)).ino;
        const models = [...config.models, { name: 'gamma' }];

        expect(await save(models, 'gamma')).toEqual({
          ...config,
          models,
          defaultModel: 'gamma',
          apiKeyConfigured: true,
          runningInstances: 1,
        });

        expect(identity()).toBe(firstId);
        expect(record((await inspectAsync(lifecycle, firstId)).State).StartedAt).toBe(
          record(before.State).StartedAt,
        );
        expect(await readFile(overlay)).toEqual(bytes);
        expect((await stat(overlay)).ino).toBe(inode);
        await observe('saved-not-restarted', 'alpha,beta', 'beta', firstSession);
        const restarted = await fetch(
          `${base}/_platform/api/admin/instances/${employee.id}/restart`,
          {
            method: 'POST',
            headers,
            body: '{}',
          },
        );
        expect(restarted.status).toBe(200);
        expect(await restarted.json()).toEqual({
          userId: employee.id,
          status: 'starting',
          reason: 'starting',
        });
        await gateway.ready(employee.cookie);
        const secondId = identity();
        expect(secondId).not.toBe(firstId);
        const after = await inspectAsync(lifecycle, secondId);
        expect(record(after.State).Running).toBe(true);
        expect(orderedMounts(after.Mounts)).toEqual(orderedMounts(before.Mounts));
        await observe('restarted', 'alpha,beta,gamma', 'gamma', await newSession());
        return secondId;
      } finally {
        gateway.close();
        await app.close();
      }
    },
  );
});

it('lets the same real held Agent turn finish after model configuration is saved', async () => {
  await withDockerIdleInstance(async (f) => {
    const admin = await registerInstanceUser(
      f.base,
      f.origin,
      'activation-task-admin@example.test',
    );
    f.database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
    const created = await f.rpc('session/create', {
      request: { cwd: '/data/work', agentPreset: 'standard' },
    });
    if (typeof created.sessionId !== 'string') throw new Error('Missing real held Session');
    const sessionId = created.sessionId;
    const nonce = randomUUID();
    await f.control({ op: 'adopt', sessionId });
    const idle = async () => {
      const items = (await f.rpc('session/list', { _request: {} })).items;
      if (!Array.isArray(items)) throw new Error('Missing real Session inventory');
      return items.some((value: unknown) => {
        const row = record(value);
        return row.sessionId === sessionId && row.running === false;
      });
    };
    await waitDockerIdle(idle);
    const held = async () => {
      const holds = (await f.control({ op: 'status' })).holds;
      if (!Array.isArray(holds)) throw new Error('Missing owned turn receipts');
      const entries: readonly unknown[] = holds;
      return entries.find((value) => record(value).nonce === nonce);
    };
    let released = false;
    try {
      await f.control({ op: 'hold', sessionId, nonce });
      await waitDockerIdle(async () => {
        const entered = await held();
        return entered !== undefined && record(entered).entered === true;
      });
      expect(await idle()).toBe(false);
      const active = { nonce, sessionId, entered: true, completed: false, aborted: false };
      expect(await held()).toEqual(active);
      const before = await inspectAsync(f.lifecycle, f.containerId);
      const response = await fetch(`${f.base}/_platform/api/admin/model-config`, {
        method: 'PUT',
        headers: { cookie: admin.cookie, origin: f.origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          baseURL: 'http://model.invalid/v1',
          models: [{ name: 'owned' }, { name: 'added' }],
          defaultModel: 'added',
        }),
      });
      expect(response.status).toBe(200);
      expect(record(await response.json()).runningInstances).toBe(1);
      expect(await held()).toEqual(active);
      expect(await idle()).toBe(false);
      expect(record((await inspectAsync(f.lifecycle, f.containerId)).State).StartedAt).toBe(
        record(before.State).StartedAt,
      );

      await f.control({ op: 'release', nonce });
      released = true;
      await waitDockerIdle(idle);

      const completed = { ...active, completed: true };
      expect(await held()).toEqual(completed);
      const status = await f.control({ op: 'status' });
      expect(status.externalModelCalls).toBe(0);
      if (!Array.isArray(status.audit)) throw new Error('Missing genuine Agent turn audit');
      const events = status.audit
        .map((value: unknown) => record(value))
        .filter((event) => event.sessionId === sessionId);
      const start = events.findLast((event) => event.type === 'turn/start');
      const end = events.findLast((event) => event.type === 'turn/end');
      expect(end).toMatchObject({ data: { reason: { kind: 'completed' } } });
      expect(end?.seq).toBeGreaterThan(Number(start?.seq));
      const evidence = resolve('.run/issue79', `held-task-${f.lifecycle.runId}.json`);
      await mkdir(resolve('.run/issue79'), { recursive: true });
      await writeFile(
        evidence,
        JSON.stringify(
          {
            active,
            completed,
            startSequence: start?.seq,
            endSequence: end?.seq,
            externalModelCalls: status.externalModelCalls,
          },
          null,
          2,
        ),
      );
    } finally {
      if (!released) await f.control({ op: 'release', nonce });
    }
  });
});
