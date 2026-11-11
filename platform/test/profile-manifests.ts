import { record } from './container-start-docker-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

/** The live Web profile manifest and the image's seed copy, read inside the running instance. */
export async function profileManifests(lifecycle: UserImageLifecycle, id: string) {
  const script = `import { readFileSync } from 'node:fs';
process.stdout.write(JSON.stringify({
  live: readFileSync('/data/home/profiles/web/package.json', 'utf8'),
  seed: readFileSync('/opt/dsh-team/profile-seed/web/package.json', 'utf8'),
}));`;
  const result = await lifecycle.commandAsync(
    ['exec', id, 'node', '--input-type=module', '-e', script],
    15_000,
  );
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Profile manifest observation failed');
  const read = record(JSON.parse(result.stdout));
  if (typeof read.live !== 'string' || typeof read.seed !== 'string')
    throw new Error('Profile manifest observation is malformed');
  return { live: read.live, seed: read.seed };
}
