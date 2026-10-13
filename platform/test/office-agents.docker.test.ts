import { expect, it } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { startBrowserPlatform } from './instance-browser-docker-fixture.ts';
import { configureInstanceModel, registerInstanceUser } from './instance-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';

it('discovers a healthy image-seeded office preset in the native selector of a fresh instance', async () => {
  await runUserImage(
    'container-start',
    () => undefined,
    undefined,
    async (lifecycle) => {
      const { app, database, base, origin } = await startBrowserPlatform(
        lifecycle,
        'dsh-team-office-bundle.invalid',
      );
      const gateway = instanceGatewayFixture({ base, origin, lifecycle });
      try {
        // No model request is sent: this config only admits ordinary instance startup.
        configureInstanceModel(database);
        const employee = await registerInstanceUser(base, origin, 'office-bundle@example.test');
        const ownership = { 'dsh-team.user': employee.id };
        lifecycle.registerResource('container', `dsh-team-u-${employee.id}`, ownership);
        for (const name of [`dsh-team-home-${employee.id}`, `dsh-team-work-${employee.id}`])
          lifecycle.registerResource('volume', name, ownership);

        expect(await gateway.state(employee.cookie, true)).toEqual({
          status: 'starting',
          reason: 'starting',
        });
        await gateway.ready(employee.cookie);
        const response = await gateway.rpc(employee.cookie, 'agentPresets/list', {});
        if (!Array.isArray(response.presets)) throw new Error('Missing native preset selector');
        const presets = response.presets.map((value: unknown) => record(value));

        const office = presets.find((preset) => preset.id === 'office-general');
        expect(office).toMatchObject({ id: 'office-general', name: '综合办公', isDefault: false });
        expect(office?.broken).toBeUndefined();
        expect(presets.filter((preset) => preset.isDefault).map((preset) => preset.id)).toEqual([
          'standard',
        ]);
        expect(presets.map((preset) => preset.id)).toEqual(
          expect.arrayContaining(['standard', 'ptc', 'minimal', 'cordis']),
        );
        process.stdout.write(
          `Office bundle selector verified: run=${lifecycle.runId} preset=office-general healthy=true default=standard\n`,
        );
        return JSON.stringify({ preset: office });
      } finally {
        gateway.close();
        await app.close();
        database.close();
      }
    },
  );
});
