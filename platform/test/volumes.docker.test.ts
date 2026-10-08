import { arch, platform } from 'node:os';
import { it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { runUserVolumes } from './volumes-fixture.ts';

it('reuses one user pair and keeps four independently owned volumes for two users', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  await runUserVolumes(loadConfig({ PLATFORM_PUBLIC_URL: 'http://127.0.0.1' }).dockerSocketPath);
});
