import { expect, it } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { startBrowserPlatform } from './instance-browser-docker-fixture.ts';
import { configureInstanceModel, registerInstanceUser } from './instance-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';

it('binds fresh Sessions to both healthy office presets with general as the native default', async () => {
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

        for (const [id, name] of [
          ['office-general', '综合办公'],
          ['office-writer', '公文与材料写作'],
        ] as const) {
          const office = presets.find((preset) => preset.id === id);
          expect(office).toMatchObject({ id, name, isDefault: id === 'office-general' });
          expect(office?.broken).toBeUndefined();
          const created = await gateway.rpc(employee.cookie, 'session/create', {
            request: { cwd: '/data/work', ...(id === 'office-writer' ? { agentPreset: id } : {}) },
          });
          expect(created.agentPreset).toBe(id);
          const catalog = await gateway.rpc(employee.cookie, 'skills/list', {
            request: { sessionId: created.sessionId },
          });
          if (!Array.isArray(catalog.skills)) throw new Error('Missing native skill catalog');
          expect(catalog.skills.map((skill: unknown) => record(skill).name)).toEqual(
            expect.arrayContaining(['office-docx', 'official-writing']),
          );
        }
        expect(presets.filter((preset) => preset.isDefault).map((preset) => preset.id)).toEqual([
          'office-general',
        ]);
        expect(presets.map((preset) => preset.id)).toEqual(
          expect.arrayContaining(['standard', 'ptc', 'minimal', 'cordis']),
        );
        process.stdout.write(
          `Office presets verified: run=${lifecycle.runId} default=office-general writer=bound skills=available\n`,
        );
        return JSON.stringify({ presets });
      } finally {
        gateway.close();
        await app.close();
        database.close();
      }
    },
  );
});
