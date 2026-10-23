import { spawnSync } from 'node:child_process';
import { dockerProxyEnvironment } from '../../scripts/docker-proxy-environment.mjs';
import { record } from './container-start-docker-fixture.ts';

// Settled fixture custody names the real creating process, joined before receipt publication.
// No outer deadline: killing this producer would orphan its Docker client and that client's
// original browserDocker deadline. Every step inside the producer is already bounded.
export function createNetworkWithProducer(args: string[]) {
  const module = new URL('../../scripts/probe-browser-runtime.mjs', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {browserDocker,processBirth} from ${JSON.stringify(module)};
const producer={pid:process.pid,birth:await processBirth(process.pid)};
const id=browserDocker(JSON.parse(process.argv[1]));
process.stdout.write(JSON.stringify({id,producer}));`,
      JSON.stringify(args),
    ],
    {
      env: {
        PATH: process.env.PATH,
        DSH_TEAM_BROWSER_DOCKER_CONFIG: process.env.DSH_TEAM_BROWSER_DOCKER_CONFIG,
        DSH_TEAM_VERIFICATION_SUBMISSIONS: process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS,
        ...dockerProxyEnvironment(),
      },
      encoding: 'utf8',
      maxBuffer: 65_536,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error('Fixture network producer did not complete');
  const value = record(JSON.parse(result.stdout));
  const producer = record(value.producer);
  if (
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.id) ||
    typeof producer.pid !== 'number' ||
    producer.pid !== result.pid ||
    typeof producer.birth !== 'string'
  )
    throw new Error('Fixture network producer identity unavailable');
  return { id: value.id, producer: { pid: producer.pid, birth: producer.birth } };
}
