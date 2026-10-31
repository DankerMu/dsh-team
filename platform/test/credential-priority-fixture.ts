import { createHash } from 'node:crypto';
import { generateManagedConfig, writeManagedConfig } from '../src/managed-config/index.ts';
import {
  collectComposition,
  execScript,
  lifecycleWebNetwork,
  qualifyHostSession,
} from './managed-policy-fixture.ts';
import {
  completeOwnedTurn,
  mappedSessionRpc,
  OWNED_COMPLETION_LEDGER,
  OWNED_COMPLETION_URL,
  ownedCompletionInstallScript,
  ownedCompletionRows,
} from './owned-completion-fixture.ts';
import { record } from './docker-cleanup.ts';
import { rejectPluginFailures } from './plugin-failure-markers.ts';
import { execWebScript, runWebStartup, webAddress } from './web-startup-fixture.ts';
import type { WebContainer, WebNetwork } from './web-startup-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const HOST = 'dsh-team-managed.invalid';
const KEY_ENV = 'DMXAPI_KEY';
// Test-owned nonsecret constants: neither is a credential for any service.
const PLATFORM_VALUE = 'dsh-team-platform-credential-nonsecret';
const EMPLOYEE_VALUE = 'dsh-team-employee-credential-nonsecret';
const CREDENTIALS = '/data/home/.credentials.yaml';
function bearerSha256(value: string): string {
  return createHash('sha256').update(`Bearer ${value}`).digest('hex');
}

/** The employee's own credential store names a different value for the managed reference. */
const employeeCredentialScript = `
import { chmodSync, statSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(CREDENTIALS)}, ${JSON.stringify(`version: 1\nrefs:\n  ${KEY_ENV}: ${EMPLOYEE_VALUE}\n`)}, { mode: 0o600 });
chmodSync(${JSON.stringify(CREDENTIALS)}, 0o600);
const stat = statSync(${JSON.stringify(CREDENTIALS)});
process.stdout.write(JSON.stringify({ uid: stat.uid, mode: (stat.mode & 0o777).toString(8) }));`;

const ledgerScript = `import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync(${JSON.stringify(OWNED_COMPLETION_LEDGER)}, 'utf8'));`;

function webContainer(
  lifecycle: UserImageLifecycle,
  suffix: string,
  overlay: string,
  network: WebNetwork,
): WebContainer {
  const container = `dsh-team-test-${lifecycle.runId}-${suffix}`;
  lifecycle.registerContainer(container);
  return {
    container,
    imageId: lifecycle.imageId,
    runId: lifecycle.runId,
    stateVolume: lifecycle.stateVolume,
    workVolume: lifecycle.workVolume,
    overlay,
    seccomp: lifecycle.seccomp,
    network,
    trustedHost: HOST,
    env: { [KEY_ENV]: PLATFORM_VALUE },
  };
}

async function managedOverlay(lifecycle: UserImageLifecycle, network: WebNetwork) {
  const composition = await collectComposition(
    lifecycle,
    `dsh-team-test-${lifecycle.runId}-credential-read`,
  );
  const generated = generateManagedConfig({
    ...composition,
    admin: false,
    instanceAddress: webAddress(network),
    modelSettings: {
      baseURL: OWNED_COMPLETION_URL,
      apiKeyEnv: KEY_ENV,
      apiKeyConfigured: true,
      models: [{ name: 'owned' }],
      defaultModel: 'owned',
    },
    defaultPermissionTier: 'yolo',
  });
  if (generated.outcome !== 'configured') throw new Error('Managed credential overlay missing');
  const rows: unknown = JSON.parse(generated.content);
  if (!Array.isArray(rows)) throw new Error('Managed credential overlay malformed');
  return writeManagedConfig(
    lifecycle.overlayDirectory,
    'credentialpr',
    JSON.stringify([...(rows as unknown[]), ...ownedCompletionRows()]),
  );
}

/**
 * F18: an employee `.credentials.yaml` entry for the managed provider's reference must not replace
 * the platform-injected value. Restarting over the edited home and sending one prompt shows which
 * value reached the owned endpoint; only SHA-256 hashes of the Authorization header are retained.
 */
export async function runCredentialPriorityScenario(
  lifecycle: UserImageLifecycle,
): Promise<string> {
  execScript(
    lifecycle,
    `dsh-team-test-${lifecycle.runId}-credential-setup`,
    ownedCompletionInstallScript(),
  );
  const network = lifecycleWebNetwork(lifecycle, 'credential');
  const overlay = await managedOverlay(lifecycle, network);
  const first = webContainer(lifecycle, 'credential-first', overlay, network);
  await runWebStartup(lifecycle.command, first);
  const credentialFile = record(
    JSON.parse(execWebScript(lifecycle.command, first, employeeCredentialScript)),
  );
  if (credentialFile.uid !== 1001 || credentialFile.mode !== '600')
    throw new Error('Employee credential file must be uid1001 0600');
  for (const args of [
    ['stop', first.container],
    ['rm', first.container],
  ]) {
    const result = lifecycle.command(args, 30_000);
    if (result.status !== 0 || result.error !== undefined)
      throw new Error('Instance restart failed');
  }
  const restarted = webContainer(lifecycle, 'credential-restart', overlay, network);
  const startup = record(JSON.parse(await runWebStartup(lifecycle.command, restarted)));
  const logs = lifecycle.command(['logs', restarted.container], 30_000);
  if (logs.status !== 0 || logs.error !== undefined || typeof startup.hostPort !== 'number')
    throw new Error('Restarted instance launch unavailable');
  // Without the realm's credentials service pi-ai falls back to the launch environment, so a failed
  // isolated store would still yield the platform value.
  rejectPluginFailures(logs, 'Restarted instance plugin load failed');
  const host = await qualifyHostSession(startup.hostPort, logs.stdout, webAddress(network));
  await completeOwnedTurn(mappedSessionRpc(host.origin, host.cookie), 'credential priority probe');
  const ledger = record(JSON.parse(execWebScript(lifecycle.command, restarted, ledgerScript)));
  const requests = Array.isArray(ledger.requests) ? ledger.requests.map(record) : [];
  const observed = requests.map((request) =>
    request.authorizationSha256 === bearerSha256(PLATFORM_VALUE)
      ? 'platform'
      : request.authorizationSha256 === bearerSha256(EMPLOYEE_VALUE)
        ? 'employee'
        : 'other',
  );
  const summary = JSON.stringify({
    credentialFile,
    total: ledger.total,
    inflight: ledger.inflight,
    observed,
  });
  if (ledger.total !== 1 || ledger.inflight !== 0 || requests.length !== 1)
    throw new Error(`Expected exactly one managed model request: ${summary}`);
  if (observed[0] !== 'platform')
    throw new Error(`Managed provider request used the ${String(observed[0])} value: ${summary}`);
  return summary;
}
