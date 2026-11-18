import { isDeepStrictEqual } from 'node:util';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import { output, record } from './docker-cleanup.ts';
import type { AsyncDockerCommand } from './docker-command.ts';

/** The firewall holder owning the bundled Document Server's network namespace (#624). */
export const DOCUMENT_SERVER_NET = 'dsh-team-documentserver-net';
const NODE = ['node', '--input-type=module', '-e'];

/** One HTTP request; `POST` sends `{}`. */
export interface ReachTarget {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly method?: 'GET' | 'POST';
}

/** `timeout`: no answer within 3s, what the holder's DROP gives; `refused` means nothing listens. */
type ReachOutcome =
  | { readonly outcome: 'answered'; readonly status: number }
  | { readonly outcome: 'timeout' | 'refused' }
  | { readonly outcome: 'failed'; readonly code: string };

/** Classifies each of argv[1]'s targets; prints only outcomes and statuses. */
const REACH = `import { request } from 'node:http';
const reach = ({ host, port, path, method = 'GET' }) => new Promise((resolve) => {
  const req = request({ host, port, path, method, timeout: 3000 }, (res) => { res.resume(); resolve({ outcome: 'answered', status: res.statusCode }); });
  req.on('timeout', () => { resolve({ outcome: 'timeout' }); req.destroy(); });
  req.on('error', (error) => resolve(error.code === 'ECONNREFUSED' ? { outcome: 'refused' } : { outcome: 'failed', code: String(error.code) }));
  req.end(method === 'POST' ? '{}' : undefined);
});
process.stdout.write(JSON.stringify(await Promise.all(JSON.parse(process.argv[1]).map(reach))));`;

async function reach(
  run: DockerOutput,
  container: string,
  user: string,
  targets: readonly ReachTarget[],
) {
  const args = ['exec', '--user', user, container, ...NODE, REACH, JSON.stringify(targets)];
  // The script above prints exactly one outcome per target.
  return JSON.parse(await run(args)) as ReachOutcome[];
}

/**
 * 55.3 (#624): `inside` from the holder's own namespace (root), then `outside` from `instance`
 * (uid 1001) to the holder's address on that instance's bridge (+4).
 */
export async function firewallReach(
  run: DockerOutput,
  instance: string,
  inside: readonly ReachTarget[],
  outside: readonly Omit<ReachTarget, 'host'>[],
) {
  const format = '{{json .NetworkSettings.Networks}}';
  const networks = record(
    JSON.parse(await run(['container', 'inspect', '-f', format, DOCUMENT_SERVER_NET])),
  );
  const network = instance.replace('dsh-team-u-', 'dsh-team-net-');
  const host = networks[network] === undefined ? undefined : record(networks[network]).IPAddress;
  if (typeof host !== 'string' || host === '')
    throw new Error(`Document Server holder has no address on ${network}`);
  return {
    inside: await reach(run, DOCUMENT_SERVER_NET, 'root', inside),
    outside: await reach(
      run,
      instance,
      '1001',
      outside.map((target) => ({ host, ...target })),
    ),
  };
}

export type NamespaceRead = (script: string) => Promise<Record<string, unknown>>;

/** JSON-printing scripts in the holder, which shares the Document Server's loopback; the JWT
 * reaches them only on stdin, never argv, logs or evidence. */
export function holderRead(command: AsyncDockerCommand, jwt: string | undefined): NamespaceRead {
  if (jwt === undefined) throw new Error('Document Server JWT was not generated');
  return async (script) => {
    const args = ['exec', '-i', DOCUMENT_SERVER_NET, ...NODE, script];
    return record(JSON.parse(output(await command(args, 30_000, jwt), args)));
  };
}

const COMMAND = { path: '/command', method: 'POST' } as const;
const ANSWERED = (status: number) => ({ outcome: 'answered', status });
// nginx matches the decoded path: these reached docservice through the version-prefix catch-all.
const ENCODED = ['command%3F', 'command%23', 'coauthoring/CommandService.ashx%3F'];
const EXPECTED_COMMAND = {
  inside: ['answered'],
  outside: [ANSWERED(200), { outcome: 'timeout' }, ...Array<object>(4).fill(ANSWERED(403))],
};

/**
 * 55.3 (#624) on the real Document Server: docservice answers its own loopback 8000; from
 * `instance`, +4:80 serves `/healthcheck`, 8000 times out and nginx refuses `/command` and the
 * version-prefixed encoded-suffix variants with 403.
 * Vitest-free (the deployment fixture imports this module); fails with the outcomes only.
 */
export async function commandReach(run: DockerOutput, instance: string) {
  const inside = [{ host: '127.0.0.1', port: 8000, ...COMMAND }];
  const outside = [
    { port: 80, path: '/healthcheck' },
    { port: 8000, ...COMMAND },
    { port: 80, ...COMMAND },
    ...ENCODED.map((path) => ({ port: 80, ...COMMAND, path: `/9.4.0-1/${path}` })),
  ];
  const seen = await firewallReach(run, instance, inside, outside);
  const observed = { inside: seen.inside.map(({ outcome }) => outcome), outside: seen.outside };
  if (!isDeepStrictEqual(observed, EXPECTED_COMMAND))
    throw new Error(
      `Command Service reach differs: observed=${JSON.stringify(seen)} expected=${JSON.stringify(EXPECTED_COMMAND)}`,
    );
  return seen;
}
