import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { isolatedBrowserRuntime, rescueChrome } from '../../scripts/probe-browser-runtime.mjs';
import { acceptObservation, mappedFlags } from '../../scripts/probe-mapped-host.mjs';
import { inspect, record } from './container-start-docker-fixture.ts';
import { startBrowserPlatform } from './instance-browser-docker-fixture.ts';
import { instanceGatewayFixture, orderedMounts } from './instance-gateway-docker-fixture.ts';
import { registerInstanceUser } from './instance-fixture.ts';
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
        lifecycle.registerResource('container', `dsh-team-u-${employee.id}`, ownership);
        for (const name of [`dsh-team-home-${employee.id}`, `dsh-team-work-${employee.id}`])
          lifecycle.registerResource('volume', name, ownership);
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
        const observe = async (label: string, models: string, expectedDefault: string) => {
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
            });
            await writeFile(join(evidence, `${label}.json`), JSON.stringify(observation, null, 2));
            expect(observation.accepted).toBe(true);
            expect(observation.reload?.accepted).toBe(true);
            expect(observation.consoleErrors).toEqual([]);
            expect(observation.preservation).toMatchObject({
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
        await observe('before-save', 'alpha,beta', 'beta');
        const peer = await gateway.open(employee.cookie);
        const before = inspect(lifecycle, firstId);
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
        expect(record(inspect(lifecycle, firstId).State).StartedAt).toBe(
          record(before.State).StartedAt,
        );
        expect(await readFile(overlay)).toEqual(bytes);
        expect((await stat(overlay)).ino).toBe(inode);
        await observe('saved-not-restarted', 'alpha,beta', 'beta');
        expect(peer.socket.destroyed).toBe(false);
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
        const after = inspect(lifecycle, secondId);
        expect(record(after.State).Running).toBe(true);
        expect(orderedMounts(after.Mounts)).toEqual(orderedMounts(before.Mounts));
        await observe('restarted', 'alpha,beta,gamma', 'gamma');
        return secondId;
      } finally {
        gateway.close();
        await app.close();
      }
    },
  );
});
